#!/usr/bin/env bash
# One-command re-run of the whole head-to-head.
#   bash bench/head-to-head/rerun.sh [--commit REV] [--dry-run] [--model sonnet] [--reps 3] [--out DIR] [--tasks z1,...] [--arms ours,baseline,...]
# Needs: node 22+ on PATH, npm, git, the `claude` CLI logged in, network for npm and git clone.
# It archives the commit under test (default HEAD) into a fresh folder, builds and packs that archive, probes the
# packed build, clones Knock's skills at the commit pinned below, runs every arm and task, then scores with the checkers.
# Every arm that uses our code runs from that archive, never from the working tree.
# --dry-run stops after the pack and the probe: no competitor clone, no claude run, no scoring.
# Pass the full model id (for example claude-sonnet-5-5): a short alias such as
# `sonnet` can fail to resolve under the throw-away HOME.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
model="sonnet"; reps=3; out=""; tasks=""; arms=""; commit="HEAD"; dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) commit="$2"; shift 2;;
    --dry-run) dry=1; shift;;
    --model) model="$2"; shift 2;;
    --reps) reps="$2"; shift 2;;
    --out) out="$2"; shift 2;;
    --tasks) tasks="$2"; shift 2;;
    --arms) arms="$2"; shift 2;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
if [ -z "$out" ]; then
  if [ "$dry" = 1 ]; then out="$(mktemp -d "${TMPDIR:-/tmp}/h2h-dry-XXXXXX")"; else out="$here/results/$(date +%Y-%m-%d)-$model"; fi
fi
mkdir -p "$out"; out="$(cd "$out" && pwd)"
work="$out/_setup"; mkdir -p "$work"

major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "Node 22 or newer is required (found $(node -v))" >&2; exit 1; }
nodebin="$work/node-bin"; mkdir -p "$nodebin"
for t in node npm npx; do ln -sf "$(command -v $t)" "$nodebin/$t"; done
export H2H_NODE_BIN="$nodebin"

# 1a. resolve the commit under test and refuse when the paths that ship have uncommitted edits
hash="$(git -C "$repo" rev-parse --verify --quiet "$commit^{commit}")" || { echo "not a commit: $commit" >&2; exit 1; }
subject="$(git -C "$repo" log -1 --format=%s "$hash")"
dirty="$(git -C "$repo" status --porcelain --untracked-files=no -- src skills hooks spec python go .claude-plugin package.json)"
if [ -n "$dirty" ]; then
  echo "REFUSED: tracked files under the shipped paths have uncommitted changes. Commit them or use a clean commit." >&2
  echo "$dirty" >&2
  exit 1
fi
printf '%s\n' "$hash" > "$out/COMMIT"
printf '%s\n' "$subject" > "$out/COMMIT_SUBJECT"

# 1b. an immutable copy of that commit: archive it into a fresh folder, build and pack inside the copy only
src="$work/src"
[ -d "$src" ] && { chmod -R u+w "$src" 2>/dev/null || true; rm -rf "$src"; }
mkdir -p "$src"
git -C "$repo" archive "$hash" | tar -x -C "$src"
( cd "$src" && node -e 'const p=require("./package.json");p.version="0.10.0-h2h.0";require("fs").writeFileSync("package.json",JSON.stringify(p,null,2))' \
  && npm install --silent --no-audit --no-fund && npm run --silent build && npm pack --silent --pack-destination "$work" >/dev/null )
# read-only after the build: the plugin directory stays readable, node_modules is left alone
find "$src" -name node_modules -prune -o -print0 | xargs -0 chmod a-w
export H2H_OURS_DIR="$src"
export H2H_TARBALL="$(ls "$work"/proactive-gate-*.tgz | head -1)"

# 1c. probe the packed build before any arm runs against it
node "$here/probe.mjs" --ours "$H2H_OURS_DIR" --tarball "$H2H_TARBALL" --commit "$hash" | tee "$out/PROBE.txt"

if [ "$dry" = 1 ]; then echo "dry run: stopping after the probe (out: $out)"; exit 0; fi

# 2. competitors at pinned commits
clone() { [ -d "$2/.git" ] || git clone --quiet "$1" "$2"; git -C "$2" checkout --quiet "$3"; }
clone https://github.com/knocklabs/skills "$work/knock" cc99682ed74ee34198602c7d28569bd1c5f309d3
export H2H_KNOCK_DIR="$work/knock"

# 3. run and score
extra=()
[ -z "$tasks" ] || extra+=(--tasks "$tasks")
[ -z "$arms" ] || extra+=(--arms "$arms")
node "$here/run.mjs" --out "$out" --model "$model" --reps "$reps" --parallel "${H2H_PARALLEL:-4}" ${extra[@]+"${extra[@]}"}
node "$here/score.mjs" --out "$out"
echo "results: $out/table-outcome.md and $out/table-full.md"
