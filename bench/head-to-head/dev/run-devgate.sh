#!/usr/bin/env bash
# Round-8 development gate: one set, one model, one iteration, on the owner's subscription (no API key).
#   bash bench/head-to-head/dev/run-devgate.sh --set k|r5|c|z|d --model claude-sonnet-5-5 --iter 1 [--commit REV] [--arms ours,baseline,courier,courier-inv] [--reps 3] [--tasks k1,k2] [--out DIR]
# Protocol: docs/DEV-GATE-round8.md (frozen before the first run). Needs the subscription wrapper at $SUB_SHIM/claude (default ~/claude-kredi-runs/sub-shim).
set -euo pipefail
# Round 9: every work directory is under /private/tmp (a cwd below /Users/efe loads the owner's CLAUDE.md into the arm).
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
set_=k; model=claude-sonnet-5-5; iter=1; commit=HEAD; arms=ours,baseline,courier,courier-inv; reps=3; tasks=""; out=""
while [ $# -gt 0 ]; do case "$1" in
  --set) set_="$2"; shift 2;; --model) model="$2"; shift 2;; --iter) iter="$2"; shift 2;; --commit) commit="$2"; shift 2;;
  --arms) arms="$2"; shift 2;; --reps) reps="$2"; shift 2;; --tasks) tasks="$2"; shift 2;; --out) out="$2"; shift 2;;
  *) echo "unknown argument $1" >&2; exit 2;; esac; done
case "$set_" in
  k) export H2H_TASKS_DIR="$here/dev/k"; default_tasks=k1,k2,k3,k4,k5;;
  r5) export H2H_TASKS_DIR="$here/results/round5-heldout/tasks"; default_tasks=g1,g2,g3,g4,g5;;
  c) export H2H_TASKS_DIR="$here/results/round6-heldout-c/tasks"; default_tasks=g1,g2,g3,g4,g5;;
  p|q|r) export H2H_TASKS_DIR="$here/dev/$set_"; default_tasks=${set_}1,${set_}2,${set_}3,${set_}4,${set_}5;;
  z) export H2H_TASKS_DIR="$here"; default_tasks=z1,z2,z3,z4,z5,z6;;
  d) export H2H_TASKS_DIR="${PG_HOLDOUT_D:-$HOME/claude-kredi-runs/2026-10-23/pg-ho-d/writer/out}"; default_tasks=d1,d2,d3,d4,d5;;
  *) echo "unknown set $set_" >&2; exit 2;; esac
[ -n "$tasks" ] || tasks="$default_tasks"
short="${model#claude-}"; short="${short%%-5-5}"
[ -n "$out" ] || out="/private/tmp/pg-r9/${PG_STAGE:-iter$iter}/$set_-$short"
export H2H_SUB=1 H2H_CLAUDE_BIN="${SUB_SHIM:-$HOME/claude-kredi-runs/sub-shim}/claude" H2H_PARALLEL="${H2H_PARALLEL:-3}"
[ -x "$H2H_CLAUDE_BIN" ] || { echo "no subscription wrapper at $H2H_CLAUDE_BIN" >&2; exit 1; }
case "$out" in /private/tmp/*) ;; *) echo "out must be under /private/tmp (isolation)" >&2; exit 2;; esac
exec bash "$here/rerun.sh" --commit "$commit" --model "$model" --reps "$reps" --tasks "$tasks" --arms "$arms" --out "$out"
