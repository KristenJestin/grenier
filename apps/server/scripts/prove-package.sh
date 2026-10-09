#!/bin/sh
# Proves the packed tarballs before anything is published: installs both into a scratch npm
# prefix and a scratch HOME, checks that `grenier --version` prints the version, then starts the
# installed `grenier serve` on a scratch database run by the PostgreSQL the package carries, and
# checks that /health answers with that version. Any failure stops with its reason.
#
#   scripts/prove-package.sh <version> <folder of the tarballs>
set -eu
version=$1
packed=$(cd "$2" && pwd)
scratch=$(mktemp -d)
database_pid=""
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  [ -n "$database_pid" ] && kill "$database_pid" 2>/dev/null || true
  rm -rf "$scratch"
}
trap cleanup EXIT

npm install --global --prefix "$scratch/prefix" \
  "$packed/netsirk-grenier-linux-x64-$version.tgz" "$packed/netsirk-grenier-$version.tgz" >/dev/null
grenier="$scratch/prefix/bin/grenier"
said=$(HOME="$scratch/home" "$grenier" --version)
if [ "$said" != "grenier v$version" ]; then
  echo "grenier --version says \"$said\", not \"grenier v$version\"." >&2
  exit 1
fi

# The PostgreSQL of the installed package, with the library links npm's blocked script would make.
native=$(dirname "$(find "$scratch/prefix/lib/node_modules" -path '*@embedded-postgres/linux-x64/package.json' | head -n 1)")/native
cp -r "$native" "$scratch/postgresql"
node -e '
const fs = require("node:fs"), path = require("node:path")
const root = process.argv[1]
for (const { source, target } of JSON.parse(fs.readFileSync(path.join(root, "pg-symlinks.json"), "utf8"))) {
  const to = path.join(root, target.replace(/^native\//, ""))
  const from = path.join(root, source.replace(/^native\//, ""))
  if (!fs.existsSync(to)) fs.symlinkSync(path.relative(path.dirname(to), from), to)
}' "$scratch/postgresql"
printf 'proof\n' >"$scratch/password"
"$scratch/postgresql/bin/initdb" -D "$scratch/database" -U grenier --pwfile="$scratch/password" \
  -A scram-sha-256 -E UTF8 --locale=C >/dev/null
port=$((40000 + $$ % 10000))
"$scratch/postgresql/bin/postgres" -D "$scratch/database" -p "$port" -k "$scratch" \
  -c listen_addresses=127.0.0.1 >"$scratch/postgres.log" 2>&1 &
database_pid=$!

server_port=$((port + 1))
HOME="$scratch/home" HIPPOCAMPE_INSTANCE=local PORT="$server_port" \
  DATABASE_URL="postgres://grenier:proof@127.0.0.1:$port/postgres" \
  BETTER_AUTH_SECRET="proof-of-the-package-0123456789abcdef0123" MEDIA_DIR="$scratch/media" \
  "$grenier" serve >"$scratch/server.log" 2>&1 &
server_pid=$!

tries=0
until health=$(curl -sf "http://127.0.0.1:$server_port/health"); do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "grenier serve did not answer /health:" >&2
    cat "$scratch/server.log" "$scratch/postgres.log" >&2
    exit 1
  fi
  sleep 0.5
done
case "$health" in
  *"\"version\":\"$version\""*) echo "Proved: grenier v$version installs, and serves /health as $version." ;;
  *)
    echo "/health answers $health, not the version $version." >&2
    exit 1
    ;;
esac
