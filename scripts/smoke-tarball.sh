#!/bin/sh
# Packs the package exactly as npm would publish it, installs the tarball in an empty
# project, imports it and runs the bin. Catches a missing `files` entry or a broken
# `exports` map before a version is on the registry.
set -eu
root=$(pwd)
name=$(node -p "require('./package.json').name")
bin=$(node -p "Object.keys(require('./package.json').bin || {})[0] || ''")
tgz=$(npm pack --silent 2>/dev/null | tail -1)
dir=$(mktemp -d)
cd "$dir"
npm init -y >/dev/null
npm install --silent --ignore-scripts "$root/$tgz"
node --input-type=module -e "import('$name').then(m => { const k = Object.keys(m); if (!k.length) throw new Error('no exports'); console.log('exports:', k.join(', ')); })"
if [ -n "$bin" ]; then npx --no "$bin" --help >/dev/null && echo "bin ok: $bin --help"; fi
cd "$root" && rm -rf "$dir" "$tgz"
