#!/bin/sh
# Builds the Flatpak of a release into scratch/flatpak/repo, for publishing on
# the Digitalku remote (flatpak.digitalku.com). Unlike build-local.sh it
# installs nothing, and it refuses to build anything but a tagged release:
# a clean working tree whose HEAD is the tag v<version>, where <version> is
# the root package.json's.
#
# Publishing is the next step, from the digitalku-flatpak repository; its
# RELEASING.md has the whole sequence.
set -eu

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
out="$root/scratch/flatpak"
cd "$root"

die() { printf 'build-release.sh: %s\n' "$*" >&2; exit 1; }

version=$(node -p 'require("./package.json").version')
tag="v$version"

[ -z "$(git status --porcelain)" ] ||
  die "the working tree has changes; a release is built from a commit"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null ||
  die "there is no tag $tag for the version in package.json"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$tag^{commit}")" ] ||
  die "HEAD is not $tag; check the tag out, or tag this commit"
grep -q "<release version=\"$version\"" packaging/flatpak/com.digitalku.roost.metainfo.xml ||
  die "the metainfo has no <release version=\"$version\">"

# What the commit holds, and nothing else: no node_modules, no dist.
rm -rf "$out/src"
mkdir -p "$out/src"
git ls-files -z | tar --null --files-from=- -cf - | tar -xf - -C "$out/src"

flatpak run org.flatpak.Builder --user --force-clean --disable-rofiles-fuse \
  --state-dir="$out/state" --repo="$out/repo" \
  --subject="Roost $version ($tag)" \
  "$out/build" "$root/packaging/flatpak/com.digitalku.roost.yml"

commit=$(flatpak run --command=ostree org.flatpak.Builder rev-parse \
  --repo="$out/repo" "app/com.digitalku.roost/$(flatpak --default-arch)/master")
printf '\nBuilt Roost %s as %s in %s\n' "$version" "$commit" "$out/repo"
printf 'Next, in digitalku-flatpak:\n  scripts/publish.sh --subject "Roost %s" com.digitalku.roost %s\n' \
  "$version" "$out/repo"
