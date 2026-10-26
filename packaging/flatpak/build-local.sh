#!/bin/sh
# Builds the Flatpak from this checkout's working tree, uncommitted edits
# included, and installs it for the user as `roost-local`.
#
# The tree is what a commit would hold (`git ls-files`, plus files git does not
# ignore), copied to `scratch/flatpak/src`, so neither `node_modules` nor a
# stale `dist` reaches the build. The submission builds from a tag instead.
set -eu

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
out="$root/scratch/flatpak"

rm -rf "$out/src"
mkdir -p "$out/src"
(cd "$root" && git ls-files -z --cached --others --exclude-standard |
  tar --null --files-from=- --ignore-failed-read -cf -) | tar -xf - -C "$out/src"

flatpak run org.flatpak.Builder --user --force-clean --disable-rofiles-fuse \
  --state-dir="$out/state" --repo="$out/repo" \
  "$out/build" "$root/packaging/flatpak/com.digitalku.roost.yml"

flatpak --user remote-add --if-not-exists --no-gpg-verify roost-local "$out/repo"
flatpak --user install -y --noninteractive --reinstall roost-local com.digitalku.roost
