#!/bin/sh
# zypak gives Chromium its sandbox inside the Flatpak's (ADR-0063 §3).
# CHROME_DESKTOP names the desktop file, so the window's app_id is the app ID.
export CHROME_DESKTOP=com.digitalku.roost.desktop
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
# Electron finds Roost in its resources/app, so no script is named here.
exec zypak-wrapper /app/electron/roost --ozone-platform-hint=auto "$@"
