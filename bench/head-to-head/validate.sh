#!/usr/bin/env bash
# usage: bench/head-to-head/validate.sh <task id, e.g. h1>
# For every ref/<id>-* entry, builds a fresh temp dir and runs checkers/<id>.mjs against it, then prints the SCORE line.
#   - a file ref/<id>-<name>.mjs is copied in as bot.mjs (the checkers that load bot.mjs);
#   - a directory ref/<id>-<name>/ (a multi-program reference, e.g. y6) is copied in whole.
# Either way fixtures/<id>/ (when it exists) is copied in as well, and package.json gets type=module.
set -euo pipefail

id="${1:?usage: validate.sh <task id, e.g. h1>}"
here="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN="${NODE_BIN:-node}"
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo "Node 22+ required" >&2
  exit 1
}

status=0
for ref in "$here"/ref/"$id"-*; do
  [ -e "$ref" ] || continue
  name="$(basename "$ref")"
  name="${name%.mjs}"
  work="$(mktemp -d)"
  if [ -d "$ref" ]; then
    cp -R "$ref"/. "$work"/
  else
    cp "$ref" "$work/bot.mjs"
  fi
  printf '{"type":"module"}\n' > "$work/package.json"
  if [ -d "$here/fixtures/$id" ]; then
    cp -R "$here/fixtures/$id"/. "$work"/
  fi
  out="$("$NODE_BIN" "$here/checkers/$id.mjs" "$work" 2>&1 || true)"
  score="$(printf '%s\n' "$out" | grep '^SCORE' | tail -1 || true)"
  echo "$name: ${score:-NO SCORE LINE}"
  if [ -z "$score" ]; then
    printf '%s\n' "$out" | tail -20 >&2
    status=1
  fi
  rm -rf "$work"
done
exit "$status"
