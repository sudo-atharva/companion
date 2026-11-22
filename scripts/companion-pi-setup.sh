#!/bin/bash
# Companion on an OctoPi (Raspberry Pi OS bookworm). Run ON THE PI as the OctoPrint user:
#
#   bash companion-pi-setup.sh /path/to/companion.asar [--spi35]
#
#   companion.asar  the Companion build (see SETUP.md "Build")
#   --spi35         also set up a generic 3.5" SPI touchscreen (ILI9486 + XPT2046, "tft35a" type)
#
# Asks for your sudo password. Changes it makes (each one is printed):
#   apt packages for X + Electron, OctoDash .deb with the Companion build swapped in, console autologin -> X ->
#   Companion autostart, CORS in OctoPrint, and with --spi35: SPI screen overlay, X on /dev/fb1, KMS off.
# Backups: /boot/firmware/config.txt.before-companion, /opt/OctoDash/resources/app.asar.upstream
set -e

ASAR="$1"
SPI35=false
[ "$2" = "--spi35" ] && SPI35=true
if [ ! -f "$ASAR" ]; then
  echo "usage: bash $0 /path/to/companion.asar [--spi35]"
  exit 1
fi

OCTODASH_VERSION=2.8.0 # Companion is built on this OctoDash release

echo "== Packages (X server, Electron libraries, xinput for touch calibration)"
sudo apt-get update -qq
sudo apt-get install -y -qq libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libuuid1 \
  libsecret-1-0 xserver-xorg xserver-xorg-video-fbdev xserver-xorg-input-libinput ratpoison x11-xserver-utils \
  xinput xinit bc desktop-file-utils libavahi-compat-libdnssd1 fonts-noto-core  # Noto: lyrics in Hindi, Arabic, …

echo "== OctoDash $OCTODASH_VERSION + the Companion build"
case "$(dpkg --print-architecture)" in
  armhf) ARCH=armv7l ;;
  arm64) ARCH=arm64 ;;
  amd64) ARCH=amd64 ;;
  *) echo "unsupported architecture"; exit 1 ;;
esac
wget -q -O /tmp/octodash.deb \
  "https://github.com/UnchartedBull/OctoDash/releases/download/v$OCTODASH_VERSION/octodash_${OCTODASH_VERSION}_$ARCH.deb"
sudo dpkg -i /tmp/octodash.deb
sudo cp -n /opt/OctoDash/resources/app.asar /opt/OctoDash/resources/app.asar.upstream
sudo cp "$ASAR" /opt/OctoDash/resources/app.asar
# your user owns the app file, so later updates need no sudo (copy a new companion.asar over it)
sudo chown "$USER" /opt/OctoDash/resources/app.asar

echo "== Autostart: console autologin -> X -> Companion (restarts itself if it exits)"
cat > ~/.xinitrc <<'EOF'
#!/bin/sh
xset s off
xset s noblank
xset -dpms
ratpoison&
while true; do octodash --no-sandbox --enable-logging=stderr >> /tmp/octodash.log 2>&1; sleep 2; done
EOF
chmod +x ~/.xinitrc
grep -q "xinit -- -nocursor" ~/.bashrc || cat >> ~/.bashrc <<'EOF'
if [ -z "$SSH_CLIENT" ] || [ -z "$SSH_TTY" ]; then
    xinit -- -nocursor
fi
EOF
grep -q "startup_message off" ~/.ratpoisonrc 2>/dev/null || echo "startup_message off" >> ~/.ratpoisonrc
sudo systemctl set-default multi-user.target
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin %s --noclear %%I $TERM\n' "$USER" |
  sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf >/dev/null
sudo chmod ug+s /usr/lib/xorg/Xorg

echo "== OctoPrint: allow CORS (the screen app talks to OctoPrint's API)"
OCTOPRINT=$(command -v octoprint || echo /opt/octopi/oprint/bin/octoprint)
[ -x "$OCTOPRINT" ] || OCTOPRINT=~/oprint/bin/octoprint
"$OCTOPRINT" config set --bool api.allowCrossOrigin true

if $SPI35; then
  echo "== 3.5\" SPI touchscreen"
  C=/boot/firmware/config.txt
  sudo cp -n $C $C.before-companion
  # goodtft LCD-show's tft35a overlay (only the overlay, not its install script): it declares the touch pen-down
  # GPIO active-low. The stock piscreen/ads7846 overlays say active-high, and current kernels then drop every touch.
  [ -d /tmp/lcdshow ] || git clone -q --depth 1 https://github.com/goodtft/LCD-show.git /tmp/lcdshow
  sudo cp /tmp/lcdshow/usr/tft35a-overlay.dtb /boot/firmware/overlays/tft35a.dtbo
  grep -q "^dtoverlay=tft35a" $C || printf '\n[all]\n# 3.5in SPI touchscreen (ILI9486 + XPT2046)\ndtparam=spi=on\ndtoverlay=tft35a:rotate=270\n' |
    sudo tee -a $C >/dev/null
  # KMS off: otherwise X takes the HDMI GPU as primary and ignores the SPI framebuffer (then fb0 = HDMI, fb1 = SPI)
  sudo sed -i 's/^dtoverlay=vc4-kms-v3d/#dtoverlay=vc4-kms-v3d  # off for the SPI screen (Companion)/' $C
  sudo mkdir -p /etc/X11/xorg.conf.d
  # X's fbdev driver needs the real device name (it rejects symlinks)
  sudo tee /etc/X11/xorg.conf.d/99-spi-lcd.conf >/dev/null <<'EOF'
Section "Device"
    Identifier "SPI LCD"
    Driver "fbdev"
    Option "fbdev" "/dev/fb1"
EndSection
Section "Screen"
    Identifier "SPI LCD Screen"
    Device "SPI LCD"
EndSection
EOF
  [ -f /etc/X11/xorg.conf.d/99-v3d.conf ] && sudo mv /etc/X11/xorg.conf.d/99-v3d.conf /etc/X11/99-v3d.conf.disabled
  printf 'Section "ServerFlags"\n    Option "AutoAddGPU" "off"\nEndSection\n' |
    sudo tee /etc/X11/xorg.conf.d/98-spi-only.conf >/dev/null
fi

echo
echo "Done. Reboot: sudo reboot"
echo "On first start the screen shows a colour test and a touch calibration, then the dashboard."
