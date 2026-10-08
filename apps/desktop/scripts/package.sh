#!/bin/sh
# Packs the viewer that `cargo build --release -p app` built, for a release:
# `scripts/package.sh <version> linux-x86_64` makes grenier-desktop-<version>-linux-x86_64.tar.gz
# (the binary, its launcher, its icon, the licences of its fonts), and `windows-x86_64` the .zip
# of the .exe; each beside its .sha256, in target/release-assets.
set -eu

version=$1
platform=$2
cd "$(dirname "$0")/.."
name="grenier-desktop-$version"
out=target/release-assets
rm -rf "$out"
mkdir -p "$out/$name/fonts"
cp assets/fonts/OFL-*.txt assets/fonts/README.md "$out/$name/fonts/"
cp assets/release/grenier.png "$out/$name/"
case $platform in
  linux-x86_64)
    cp target/release/grenier-desktop assets/release/grenier.desktop "$out/$name/"
    archive="$name-$platform.tar.gz"
    (cd "$out" && tar -czf "$archive" "$name")
    ;;
  windows-x86_64)
    cp target/release/grenier-desktop.exe "$out/$name/"
    archive="$name-$platform.zip"
    (cd "$out" && 7z a -tzip -bso0 "$archive" "$name")
    ;;
  *)
    echo "Unknown platform $platform: linux-x86_64 or windows-x86_64." >&2
    exit 1
    ;;
esac
(cd "$out" && sha256sum "$archive" >"$archive.sha256")
echo "$out/$archive"
