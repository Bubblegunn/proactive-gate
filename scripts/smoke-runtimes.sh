#!/bin/sh
set -eu
root=$(pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT HUP INT TERM

npm pack --ignore-scripts --loglevel=error --pack-destination "$dir" >/dev/null
set -- "$dir"/*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "expected one packed tarball" >&2
  exit 1
fi
tgz=$1
cd "$dir"
printf '%s\n' '{"name":"runtime-smoke","private":true,"type":"module"}' > package.json
# Generate an integrity-pinned lock from the local tarball, then install without registry access.
npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund "$tgz" >/dev/null
npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
cp "$root/test/fixtures/runtime-smoke.mjs" smoke.mjs

node --experimental-vm-modules "$root/scripts/check-main-imports.mjs" node_modules/proactive-gate
bun --version
bun run smoke.mjs
deno --version
deno run --no-config --no-lock --node-modules-dir=manual --cached-only --no-prompt smoke.mjs
