#!/bin/sh
# zypak gives Chromium its sandbox inside the Flatpak's (ADR-0063 §3).
# CHROME_DESKTOP names the desktop file, so the window's app_id is the app ID.
export CHROME_DESKTOP=com.digitalku.roost.desktop
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
# The title bar is GTK's, drawn from the desktop's theme, which the sandbox
# only has if its org.gtk.Gtk3theme extension is installed; without it GTK falls
# back to light Adwaita over a dark window. A GTK_THEME already set (a
# `flatpak override --env`) wins (ADR-0063 §4).
export GTK_THEME="${GTK_THEME:-Adwaita:dark}"
# Electron finds Roost in its resources/app, so no script is named here.
exec zypak-wrapper /app/electron/roost --ozone-platform-hint=auto "$@"
