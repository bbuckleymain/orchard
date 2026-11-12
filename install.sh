#!/usr/bin/env bash
#
# Installs Orchard for this user: the app into ~/.local/share/orchard, a launcher
# in ~/.local/bin, and an entry with an icon in the application menu.
# Run it again after changing the code to update the installed copy.
#
#   ./install.sh            install or update
#   ./install.sh --remove   uninstall (your sign-in and settings in ~/.config/Orchard are kept)
#
set -euo pipefail
cd "$(dirname "$0")"

DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APP="$DATA/orchard"
BIN="$HOME/.local/bin/orchard"
DESKTOP="$DATA/applications/orchard.desktop"
ICON="$DATA/icons/hicolor/scalable/apps/orchard.svg"
ICON_PNG="$DATA/icons/hicolor/512x512/apps/orchard.png"

refresh_menu() {
    update-desktop-database "$DATA/applications" 2>/dev/null || true
    gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true
    kbuildsycoca6 --noincremental >/dev/null 2>&1 || kbuildsycoca5 >/dev/null 2>&1 || true
}

if [[ "${1:-}" == "--remove" ]]; then
    rm -rf "$APP" "$BIN" "$DESKTOP" "$ICON" "$ICON_PNG"
    refresh_menu
    echo "Orchard removed."
    exit 0
fi

# Replacing the app's files under a running Orchard breaks that window, so wait until it's closed.
if pgrep -f "$APP/node_modules/electron/dist/electron" >/dev/null 2>&1; then
    echo "Orchard is running. Close it, then run ./install.sh again." >&2
    exit 1
fi

if [[ ! -x node_modules/electron/dist/electron ]]; then
    npm install
    node node_modules/electron/install.js   # npm 12 skips install scripts; this fetches the castLabs binary
fi

mkdir -p "$APP" "$(dirname "$BIN")" "$(dirname "$DESKTOP")" "$(dirname "$ICON")" "$(dirname "$ICON_PNG")"
# Fresh copy of the app (Electron itself included), leaving nothing stale behind.
rm -rf "$APP.new"
mkdir -p "$APP.new"
cp -a main.js preload.js lyrics-sources.js lastfm.js mpris.js musixmatch.js package.json ui node_modules "$APP.new/"
rm -rf "$APP"
mv "$APP.new" "$APP"

cat > "$BIN" <<LAUNCH
#!/bin/sh
# Don't let a CHROME_DESKTOP inherited from another Chromium app through: castLabs Electron's
# zygote crashes at startup when it's set. The window class comes from the app name instead.
unset CHROME_DESKTOP
exec "$APP/node_modules/electron/dist/electron" "$APP" "\$@"
LAUNCH
chmod +x "$BIN"

cp ui/orchard.svg "$ICON"
cp ui/orchard.png "$ICON_PNG"

cat > "$DESKTOP" <<ENTRY
[Desktop Entry]
Type=Application
Name=Orchard
GenericName=Music Player
Comment=Apple Music, in Frutiger Aero
Exec=$BIN %U
Icon=orchard
Terminal=false
Categories=AudioVideo;Audio;Player;
Keywords=apple;music;itunes;lyrics;player;
StartupNotify=true
StartupWMClass=orchard
ENTRY

refresh_menu
echo "Orchard installed. Find it in your application menu, or run: orchard"
