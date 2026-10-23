# Reproduce round8-final

Build sha: `5fe287e8472ec32e4c357e9b0c22a484466a3ad0`. Protocol commit: `f160af98731ce59b25a34051f8630db6dfef713f`. Date of the original runs: 2026-10-23.

## 1. Get the code and the pinned build

```
git clone https://github.com/Bubblegunn/proactive-gate.git proactive-gate
cd proactive-gate
git checkout 5fe287e8472ec32e4c357e9b0c22a484466a3ad0
```

## 2. Extract the tasks

```
mkdir -p ../heldout-tasks
cp -R <EVIDENCEDIR>/tasks/. ../heldout-tasks/
export H2H_TASKS_DIR="$PWD/../heldout-tasks"     # prompts/, checkers/, ref/, labels.json, fixtures/ if any
```

The public set (if included) is in `tasks/public/`; extract it the same way and point `H2H_TASKS_DIR` at it for those tasks.

## 3. Pick the claude binary

```
export H2H_CLAUDE_BIN="$(command -v claude)"      # the plain Claude Code CLI is fine for a stranger
```

The original runs used the local Agent SDK shim (`~/claude-kredi-runs/sdk-shim/claude`, which calls `claude_agent_sdk.query`). The shim is not published.
The CLI path has a different tool and skill set (see `env.json`), so absolute scores and costs can differ.
`H2H_PARALLEL=3` matches the original parallelism. Needs node 22 or newer, npm, git, network, and a logged-in `claude`.

## 4. Rerun (one command per model; rerun.sh clones and pins the competitors, packs the build, runs, and scores)

```
export H2H_PARALLEL=3
bash bench/head-to-head/rerun.sh --commit 5fe287e8472ec32e4c357e9b0c22a484466a3ad0 --model claude-sonnet-5-5 --reps 3 \
  --arms ours,baseline,knock,knock-inv,courier,courier-inv \
  --tasks d1,d2,d3,d4,d5 --out /tmp/rerun-MODEL
```

Use the full model id (a short alias can fail to resolve under the throw-away HOME). Repeat for each model id listed in `env.json`.

## 5. Score the rerun

```
export H2H_NODE_BIN="$(dirname "$(command -v node)")"
node bench/head-to-head/score.mjs --out /tmp/rerun-MODEL
```

## 6. Rebuild an evidence folder from the rerun and rescore

```
python3 bench/head-to-head/tools/build-evidence.py --out /tmp/evidence-rerun --round-id round8-final-rerun \
  --held-out-tasks ../heldout-tasks --models MODEL=/tmp/rerun-MODEL \
  --protocol-sha f160af98731ce59b25a34051f8630db6dfef713f --build-sha 5fe287e8472ec32e4c357e9b0c22a484466a3ad0 --date YYYY-MM-DD
python3 /tmp/evidence-rerun/score.py
```

To rescore the original evidence without any rerun: `python3 score.py` and `python3 score.py --check SUMMARY.md` in this folder.

## Expected cost and time (real totals of the original runs, from `runs/*/*/*/*/cost.json`)

- sonnet (heldout): 90 cells, 13.35 USD, 83 minutes of run time summed over cells (about 28 minutes wall time at parallelism 3)
- sonnet (public): 108 cells, 19.91 USD, 136 minutes of run time summed over cells (about 45 minutes wall time at parallelism 3)
- all: 33.26 USD, 218 minutes summed over cells

Cost on the SDK path is list price; a CLI run on a subscription or another tier will report different numbers.

## What differs on a rerun

- Model variance: the same cell can score differently on another run. The per-cell spread inside this folder (min-max in the tables) shows the size of it.
- Cost, turns and time vary with the run path (SDK shim or CLI) and the day.
- F6 agreement: see SUMMARY.md
