# Companion OctoPrint plugin

Serves the Companion web editor at `/plugin/companion/` and the screen config API at `/api/plugin/companion`:
read/write the touchscreen's config, restart it, start touch calibration, store the Spotify login
(PKCE code exchanged here, the token never reaches the browser), and print with the printer off
(plug on -> connect -> print).

The web app itself is the Companion build: copy `dist/en` from the app build to
`octoprint_companion/static/web/` before installing.
