# Setting up Companion

You need:

- A Raspberry Pi running [OctoPi](https://octoprint.org/download/) (Raspberry Pi OS bookworm; tested on a Pi 3B+, 32-bit).
- A touchscreen: a 3.5" SPI screen or any HDMI/DSI screen.
- A PC to build on.

Optional:

- A TP-Link Tapo P110/P115 plug, for power control and watts.
- Spotify Premium, for the Music app.
- Tailscale, for remote access and HTTPS.

Throughout this guide, `<pi>` means your Pi's address, e.g. `octopi.local` or its IP.

## 1. Build (on your PC)

Needs Node.js 24.

```bash
git clone https://github.com/sudo-atharva/companion.git
cd companion
npm ci
npm run build                      # -> dist/

# package the screen app (Electron) as companion.asar
mkdir -p ../companion-app/src
cp -r package.json main.js dist themes LICENSE.md ../companion-app/
cp -r src/helper ../companion-app/src/
(cd ../companion-app && npm install --omit=dev --ignore-scripts)
npx @electron/asar pack ../companion-app companion.asar
```

## 2. Install on the Pi

```bash
scp companion.asar scripts/companion-pi-setup.sh <user>@<pi>:/tmp/
ssh -t <user>@<pi> "bash /tmp/companion-pi-setup.sh /tmp/companion.asar --spi35 && sudo reboot"
```

- Leave out `--spi35` if your screen isn't a 3.5" SPI screen (HDMI/DSI screens need no driver setup).
- What the script changes is listed at the top of [scripts/companion-pi-setup.sh](scripts/companion-pi-setup.sh). It keeps backups of `config.txt` and the original app.

**First start:** a colour test, then 4 crosses for the touch calibration. Then the Companion dashboard appears.

## 3. Connect the printer side

On the screen, tap **Printer**. This opens OctoDash's setup wizard, so plug in a USB keyboard. Enter OctoPrint's address (`http://localhost`), then approve the app key in OctoPrint's web UI. Only enable the plugins you actually have installed in OctoPrint.

## 4. Companion OctoPrint plugin (web editor)

This plugin gives you:

- The web editor at `http://<pi>/plugin/companion/`: live preview, Dashboard, Deck, Screen, Setup, Printer settings.
- **Print with the printer off.**
- The Spotify login.

```bash
cp -r dist/en octoprint-plugin/octoprint_companion/static/web     # the web app is the same build
scp -r octoprint-plugin <user>@<pi>:/tmp/
ssh <user>@<pi> "~/oprint/bin/pip install /tmp/octoprint-plugin || /opt/octopi/oprint/bin/pip install /tmp/octoprint-plugin"
```

Then restart OctoPrint (⏻ menu > Restart OctoPrint) and open `http://<pi>/plugin/companion/`. It asks for your OctoPrint login.

## 5. Power plug (Tapo P110/P115)

1. In the Tapo app: **Me > Third-Party Services > Third-Party Compatibility: on**.
2. OctoPrint > Plugin Manager > Get More > from URL:
   `https://github.com/sudo-atharva/OctoPrint-PSUControl-Tapo/archive/main.zip`
   Restart OctoPrint.
3. Web editor > **Setup > Power plug**: Tapo email and password, **Auto-detect**, pick the plug, Save, test On/Off.
4. In OctoDash's settings (web editor > Printer > Plugins) enable **PSU Control**. The Tapo plugin answers its API.

## 6. Tailscale (remote access + HTTPS)

Needed for the Spotify login, which only returns to `https://` addresses.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up            # open the link, log in
sudo tailscale serve --bg 80 # https://<pi-name>.<tailnet>.ts.net -> OctoPrint + Companion
```

If `serve` asks for it, enable **HTTPS Certificates** at login.tailscale.com/admin/dns. The device you browse from needs Tailscale running too.

## 7. Spotify (Music app)

1. At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), **Create app**:
   - Redirect URI: exactly `https://<pi-name>.<tailnet>.ts.net/plugin/companion/` (the editor's Setup tab shows it).
   - APIs: **Web API**.
2. Open the editor through that `https://` address > **Setup > Spotify**. Paste the app's **Client ID**, then **Connect Spotify** and log in.
3. On the screen: **Music**. It controls whatever plays on your phone, PC or speaker (Premium needed).

The login is stored only on the Pi. The browser never sees the token.

## 8. Thumbnails

1. Install **Slicer Thumbnails** (Plugin Manager > Get More).
2. In your slicer, turn on G-code thumbnails. For PrusaSlicer/OrcaSlicer: `32x32/PNG, 300x300/PNG`.
3. Upload files to OctoPrint. Files on the printer's SD card can't have thumbnails.

## Updating

Build a new `companion.asar` (step 1), then:

```bash
scp companion.asar <user>@<pi>:/opt/OctoDash/resources/app.asar
ssh <user>@<pi> 'pkill -f "^octodash --no-sandbox"'     # restarts by itself
```

For the plugin, repeat step 4.

## Troubleshooting

| Problem                           | Fix                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Screen white, then black          | X didn't start. Check `/var/log/Xorg.0.log`. SPI screen: run the script with `--spi35`.                                              |
| Touch registers only now and then | Use the `tft35a` overlay (the script does). `piscreen`/`ads7846` drop touches on current kernels.                                    |
| Touch is offset or mirrored       | Settings > Calibrate touch                                                                                                           |
| "OctoPrint server is not running" | OctoPrint needs about 1.5 min after power-on on a Pi 3. Shut the Pi down properly; otherwise the next boot checks the SD card first. |
| Power card shows "–"              | Tapo plugin not set up (step 5), or PSU Control not enabled in OctoDash's settings                                                   |
| Spotify "redirect URI" error      | The Redirect URI in the Spotify app must match the editor's `https://` address exactly, including the trailing `/`                   |
| App log                           | `/tmp/octodash.log` on the Pi                                                                                                        |
