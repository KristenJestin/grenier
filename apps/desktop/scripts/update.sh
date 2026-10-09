#!/bin/sh
# Installs or updates the Hippocampe desktop viewer on Linux from the latest release on GitHub, read
# through the public API (no token): the binary into ~/.local/bin, its launcher and its icon into
# ~/.local/share. Run it from anywhere, a copy of it or `curl -fsSL <its raw URL> | sh`; `--check`
# only says whether a newer viewer exists. The configuration and the key (~/.config/hippocampe) are
# never touched. The whole script is one function called on its last line: a download cut short
# runs nothing.
set -eu

update() {
  API="${HIPPOCAMPE_RELEASES_API:-https://api.github.com/repos/KristenJestin/hippocampe/releases/latest}"
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  BIN="$HOME/.local/bin"
  APPS="$DATA/applications"
  ICONS="$DATA/icons/hicolor/256x256/apps"

  platform="$(uname -s) $(uname -m)"
  if [ "$platform" != "Linux x86_64" ]; then
    echo "Hippocampe has no viewer for $platform: only Linux x86_64 is released." >&2
    exit 1
  fi

  check=false
  if [ "${1:-}" = "--check" ]; then check=true; fi

  release=$(curl -fsSL "$API")
  latest=$(printf '%s\n' "$release" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  if [ -z "$latest" ]; then
    echo "No release of Hippocampe was found at $API." >&2
    exit 1
  fi

  # Asked without a display and for five seconds at most: a viewer older than --version would
  # open its window instead of answering, and is then replaced as if none were installed.
  installed=""
  if [ -x "$BIN/hippocampe-desktop" ]; then
    installed=$(env -u WAYLAND_DISPLAY -u DISPLAY timeout 5 "$BIN/hippocampe-desktop" --version 2>/dev/null |
      sed -n 's/^hippocampe-desktop //p' | head -n 1)
  fi
  if [ "$installed" = "$latest" ]; then
    echo "hippocampe-desktop $installed is the latest."
    exit 0
  fi
  if [ -n "$installed" ] && [ "$installed" != unknown ] &&
    [ "$(printf '%s\n%s\n' "$latest" "$installed" | sort -V | tail -n 1)" = "$installed" ]; then
    echo "hippocampe-desktop $installed is newer than the latest release, $latest: nothing to do."
    exit 0
  fi
  if $check; then
    echo "hippocampe-desktop $latest is available (installed: ${installed:-none})."
    exit 0
  fi

  name="hippocampe-desktop-$latest-linux-x86_64.tar.gz"
  url=$(printf '%s\n' "$release" | grep -o "\"browser_download_url\": *\"[^\"]*/$name\"" |
    sed 's/.*"\(http[^"]*\)"$/\1/' | head -n 1)
  if [ -z "$url" ]; then
    echo "The release $latest has no $name yet: its builds may still run," \
      "or one failed; try again later." >&2
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
  unpacked="$work/hippocampe-desktop-$latest"

  mkdir -p "$BIN" "$APPS" "$ICONS"
  # Written beside it, then renamed over it: a viewer running keeps the file it started from.
  install -m 755 "$unpacked/hippocampe-desktop" "$BIN/.hippocampe-desktop.new"
  mv -f "$BIN/.hippocampe-desktop.new" "$BIN/hippocampe-desktop"
  sed "s|^Exec=.*|Exec=\"$BIN/hippocampe-desktop\"|" "$unpacked/hippocampe.desktop" >"$APPS/hippocampe.desktop"
  cp "$unpacked/hippocampe.png" "$ICONS/hippocampe.png"
  echo "hippocampe-desktop $latest is installed in $BIN."
  # The viewer as it was named while Hippocampe was named Grenier: replaced, not left beside.
  if [ -e "$BIN/grenier-desktop" ] || [ -e "$APPS/grenier.desktop" ] || [ -e "$ICONS/grenier.png" ]; then
    rm -f "$BIN/grenier-desktop" "$APPS/grenier.desktop" "$ICONS/grenier.png"
    echo "Removed the viewer installed as grenier-desktop, its launcher and its icon."
  fi
}

update "$@"
