#!/bin/sh
# Installs or updates the Grenier desktop viewer on Linux from the latest release on GitHub, read
# through the public API (no token): the binary into ~/.local/bin, its launcher and its icon into
# ~/.local/share. Run it from anywhere, a copy of it or `curl -fsSL <its raw URL> | sh`; `--check`
# only says whether a newer viewer exists. The configuration and the key (~/.config/grenier) are
# never touched.
set -eu

API="${GRENIER_RELEASES_API:-https://api.github.com/repos/KristenJestin/grenier/releases/latest}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN="$HOME/.local/bin"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor/256x256/apps"

check=false
if [ "${1:-}" = "--check" ]; then check=true; fi

release=$(curl -fsSL "$API")
latest=$(printf '%s\n' "$release" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
if [ -z "$latest" ]; then
  echo "No release of Grenier was found at $API." >&2
  exit 1
fi

installed=""
if [ -x "$BIN/grenier-desktop" ]; then
  installed=$("$BIN/grenier-desktop" --version | sed 's/^grenier-desktop //')
fi
if [ "$installed" = "$latest" ]; then
  echo "grenier-desktop $installed is the latest."
  exit 0
fi
if [ -n "$installed" ] && [ "$installed" != unknown ] &&
  [ "$(printf '%s\n%s\n' "$latest" "$installed" | sort -V | tail -n 1)" = "$installed" ]; then
  echo "grenier-desktop $installed is newer than the latest release, $latest: nothing to do."
  exit 0
fi
if $check; then
  echo "grenier-desktop $latest is available (installed: ${installed:-none})."
  exit 0
fi

name="grenier-desktop-$latest-linux-x86_64.tar.gz"
url=$(printf '%s\n' "$release" | grep -o "\"browser_download_url\": *\"[^\"]*/$name\"" |
  sed 's/.*"\(http[^"]*\)"$/\1/' | head -n 1)
if [ -z "$url" ]; then
  echo "The release $latest has no $name." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/$name" "$url"
curl -fsSL -o "$work/$name.sha256" "$url.sha256"
expected=$(cut -d ' ' -f 1 <"$work/$name.sha256")
actual=$(sha256sum "$work/$name" | cut -d ' ' -f 1)
if [ "$expected" != "$actual" ]; then
  echo "The checksum of $name does not match its release: nothing was installed." >&2
  exit 1
fi
tar -xzf "$work/$name" -C "$work"
unpacked="$work/grenier-desktop-$latest"

mkdir -p "$BIN" "$APPS" "$ICONS"
# Written beside it, then renamed over it: a viewer running keeps the file it started from.
install -m 755 "$unpacked/grenier-desktop" "$BIN/.grenier-desktop.new"
mv -f "$BIN/.grenier-desktop.new" "$BIN/grenier-desktop"
sed "s|^Exec=.*|Exec=$BIN/grenier-desktop|" "$unpacked/grenier.desktop" >"$APPS/grenier.desktop"
cp "$unpacked/grenier.png" "$ICONS/grenier.png"
echo "grenier-desktop $latest is installed in $BIN."
