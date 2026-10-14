#!/bin/sh
# Packs the package exactly as npm would publish it, installs the tarball in an empty
# project, imports it and runs the bin. Catches a missing `files` entry or a broken
# `exports` map before a version is on the registry.
set -eu
root=$(pwd)
name=$(node -p "require('./package.json').name")
bin=$(node -p "Object.keys(require('./package.json').bin || {})[0] || ''")
pack=$(npm pack --json 2>/dev/null)
tgz=$(printf '%s' "$pack" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8'))[0].filename)")
dir=$(mktemp -d)
cp "$tgz" "$dir/package.tgz"
cd "$dir"
# The consumer project gets a lockfile naming the tarball and its sha512, so the install is
# `npm ci`: npm verifies the integrity of what it unpacks and resolves nothing from a registry.
# The package has no dependencies, so the tarball is the whole tree.
PACK="$pack" node -e "
const fs = require('fs');
const [p] = JSON.parse(process.env.PACK);
const manifest = JSON.parse(require('child_process').execFileSync('tar', ['-xzOf', 'package.tgz', 'package/package.json'], { encoding: 'utf8' }));
const dep = { [p.name]: 'file:package.tgz' };
fs.writeFileSync('package.json', JSON.stringify({ name: 'smoke', version: '1.0.0', private: true, dependencies: dep }, null, 2));
const entry = { version: p.version, resolved: 'file:package.tgz', integrity: p.integrity };
if (manifest.license) entry.license = manifest.license;
if (manifest.bin) entry.bin = manifest.bin;
if (manifest.engines) entry.engines = manifest.engines;
fs.writeFileSync('package-lock.json', JSON.stringify({ name: 'smoke', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'smoke', version: '1.0.0', dependencies: dep }, ['node_modules/' + p.name]: entry } }, null, 2));
"
npm ci --silent --ignore-scripts
node --input-type=module -e "import('$name').then(m => { const k = Object.keys(m); if (!k.length) throw new Error('no exports'); console.log('exports:', k.join(', ')); })"
# Subpath exports are part of the contract: presets and one adapter must resolve from the tarball.
node --input-type=module -e "Promise.all([import('$name/presets'), import('$name/ai-sdk')]).then(([p, a]) => { if (!p.presets || !Object.keys(p.presets).length) throw new Error('no presets'); if (!Object.keys(a).length) throw new Error('ai-sdk subpath is empty'); console.log('subpaths ok: presets (' + Object.keys(p.presets).length + '), ai-sdk'); })"
# `--` keeps npx from reading --help as its own option (npm 11 then exits 0 for a missing bin), and the
# explicit exit is needed because a failing command on the left of `&&` does not trip `set -e`: until
# 2026-10-14 this line printed nothing and the script still exited 0 when the bin path was broken.
if [ -n "$bin" ]; then
  npx --no -- "$bin" --help >/dev/null || { echo "bin failed: $bin --help" >&2; exit 1; }
  echo "bin ok: $bin --help"
fi
cd "$root" && rm -rf "$dir" "$tgz"
