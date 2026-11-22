# coding=utf-8
"""Companion for OctoPrint.

- Serves the Companion web app at /plugin/companion/: the control panel for the touchscreen (same address as OctoPrint).
- /api/plugin/companion: read/write the touchscreen's config and restart the screen app.
"""
import json
import os
import subprocess
import threading
import time

import flask
import requests
import octoprint.plugin
import octoprint.settings
from octoprint.access.permissions import Permissions

WEB = os.path.join(os.path.dirname(__file__), "static", "web")
# ponytail: the screen app runs on this Pi as the same user as OctoPrint, so its electron-store file is edited
# directly. A screen on another machine would need the screen to fetch its config from this API instead.
STORE = os.path.expanduser("~/.config/octodash/config.json")


class CompanionPlugin(octoprint.plugin.BlueprintPlugin, octoprint.plugin.SimpleApiPlugin):
    # The page holds no secrets and must load for logged-out visitors so it can send them to OctoPrint's login.
    # Everything it reads or changes goes through the API below, which needs the login + settings permission.
    def is_blueprint_protected(self):
        return False

    @octoprint.plugin.BlueprintPlugin.route("/", methods=["GET"])
    def index(self):
        return flask.send_from_directory(WEB, "index.html")

    @octoprint.plugin.BlueprintPlugin.route("/<path:filename>", methods=["GET"])
    def files(self, filename):
        return flask.send_from_directory(WEB, filename)

    # ---- screen config API ----

    def is_api_protected(self):
        return True  # login required (plus the settings permission, checked below)

    def get_api_commands(self):
        return dict(save=["config"], restart=[], recalibrate=[], spotify=["clientId", "code", "verifier", "redirectUri"],
                    spotifyClient=["clientId"], printWhenReady=["path"])

    def on_api_get(self, request):
        if not Permissions.SETTINGS.can():
            flask.abort(403)
        store = self._read()
        spotify = store.get("spotify") or {}
        # never hand the refresh token to the browser; only the screen uses it
        return flask.jsonify(config=store.get("config"),
                             spotify=dict(clientId=spotify.get("clientId"), connected=bool(spotify.get("refreshToken"))))

    def on_api_command(self, command, data):
        if command == "printWhenReady":
            if not Permissions.PRINT.can():
                flask.abort(403)
            return flask.jsonify(state=self._print_when_ready(str(data["path"])))
        if not Permissions.SETTINGS.can():
            flask.abort(403)
        self._logger.info("API command %s, fields %s", command, sorted(k for k in data if k != "command"))
        store = self._read()
        if command == "save":
            if not isinstance(data.get("config"), dict):
                flask.abort(400, description="config must be an object")
            store["config"] = data["config"]
            self._write(store)
        elif command == "spotify":
            # PKCE code -> refresh token, done here instead of in the browser (no CORS/shield problems,
            # and the token never reaches the browser)
            try:
                token = requests.post("https://accounts.spotify.com/api/token", timeout=20, data=dict(
                    grant_type="authorization_code", code=data["code"], redirect_uri=data["redirectUri"],
                    client_id=data["clientId"], code_verifier=data["verifier"])).json()
            except requests.RequestException as e:
                self._logger.error("Spotify token request failed: %s", e)
                return flask.make_response(flask.jsonify(error=str(e)), 502)
            if "refresh_token" not in token:
                self._logger.error("Spotify refused the login: %s", token)
                return flask.make_response(flask.jsonify(error=token.get("error_description") or token.get("error")), 400)
            store["spotify"] = dict(clientId=str(data["clientId"]), refreshToken=token["refresh_token"])
            self._write(store)
        elif command == "spotifyClient":
            store["spotify"] = dict(store.get("spotify") or {}, clientId=str(data["clientId"]))
            self._write(store)
            return flask.jsonify(ok=True)  # nothing for the screen to reload yet
        elif command == "recalibrate":
            store.pop("touchCalibration", None)  # screen shows the screen test + calibration on next start
            self._write(store)
        self._restart_screen()
        return flask.jsonify(ok=True)

    # ---- print with the printer off: plug on -> connect -> print ----

    def _print_when_ready(self, full_path):
        """full_path as OctoDash sends it: /local/dir/file.gcode or /sdcard/file.gco"""
        origin, _, path = full_path.lstrip("/").partition("/")
        sd = origin != "local"
        if self._printer.is_operational():
            self._printer.select_file(path, sd, printAfterSelect=True)
            return "printing"
        if self._printer.is_printing():
            return "busy"
        self._power_on()
        threading.Thread(target=self._wait_and_print, args=(path, sd), daemon=True).start()
        return "poweringOn"

    def _power_on(self):
        helpers = self._plugin_manager.get_helpers("psucontrol", "turn_psu_on")
        if helpers:  # the real PSU Control plugin
            helpers["turn_psu_on"]()
            return
        tapo = self._plugin_manager.get_plugin_info("psucontrol_tapo", require_enabled=True)
        if tapo:
            tapo.implementation.switch("on")
        else:
            self._logger.warning("No PSU Control / Tapo plugin: can't switch the printer on")

    def _wait_and_print(self, path, sd):
        # ponytail: fixed timings (printer boot ~20 s, give up after 3 min); make them settings if a printer needs longer
        start = time.time()
        last_connect = 0.0
        while time.time() - start < 180:
            if self._printer.is_operational():
                self._logger.info("Printer ready, printing %s", path)
                self._printer.select_file(path, sd, printAfterSelect=True)
                return
            # the Tapo plugin auto-connects on power-on; connect ourselves too in case nothing else does
            if time.time() - start > 20 and self._printer.is_closed_or_error() and time.time() - last_connect > 30:
                s = octoprint.settings.settings()
                self._printer.connect(port=s.get(["serial", "port"]), baudrate=s.getInt(["serial", "baudrate"]))
                last_connect = time.time()
            time.sleep(2)
        self._logger.error("Printer did not become ready within 3 min, not printing %s", path)

    def _read(self):
        try:
            with open(STORE, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return {}

    def _write(self, store):
        os.makedirs(os.path.dirname(STORE), exist_ok=True)
        tmp = STORE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(store, f, indent="\t")
        os.replace(tmp, STORE)  # atomic: the screen app may read it at any moment
        self._logger.info("Screen config written, keys %s", sorted(store))

    def _restart_screen(self):
        # the screen's .xinitrc loop starts it again, which loads the new config
        subprocess.run(["pkill", "-f", "^octodash --no-sandbox"], check=False)
        self._logger.info("Screen app restarted")


__plugin_name__ = "Companion"
__plugin_author__ = "sudo-atharva"
__plugin_url__ = "https://github.com/sudo-atharva/companion"
__plugin_license__ = "Apache-2.0"
__plugin_description__ = "Companion: control panel for the Companion touchscreen (dashboard, dock, deck, music, setup)"
__plugin_pythoncompat__ = ">=3.9,<4"
__plugin_implementation__ = CompanionPlugin()
