# Reproduce round5-heldout

Build sha: `5dbfaf3`. Protocol commit: `6140b94`. Date of the original runs: 2026-10-22.

## 1. Get the code and the pinned build

```
git clone https://github.com/Bubblegunn/proactive-gate.git proactive-gate
cd proactive-gate
git checkout 5dbfaf3
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
bash bench/head-to-head/rerun.sh --commit 5dbfaf3 --model claude-haiku-5-5 --reps 3 \
  --arms ours,baseline,knock,knock-inv,courier,courier-inv \
  --tasks g1,g2,g3,g4,g5 --out /tmp/rerun-MODEL
```

Use the full model id (a short alias can fail to resolve under the throw-away HOME). Repeat for each model id listed in `env.json`.

## 5. Score the rerun

```
export H2H_NODE_BIN="$(dirname "$(command -v node)")"
node bench/head-to-head/score.mjs --out /tmp/rerun-MODEL
```

## 6. Rebuild an evidence folder from the rerun and rescore

```
python3 bench/head-to-head/tools/build-evidence.py --out /tmp/evidence-rerun --round-id round5-heldout-rerun \
  --held-out-tasks ../heldout-tasks --models MODEL=/tmp/rerun-MODEL \
  --protocol-sha 6140b94 --build-sha 5dbfaf3 --date YYYY-MM-DD
python3 /tmp/evidence-rerun/score.py
```

To rescore the original evidence without any rerun: `python3 score.py` and `python3 score.py --check SUMMARY.md` in this folder.

## Expected cost and time (real totals of the original runs, from `runs/*/*/*/*/cost.json`)

- haiku (heldout): 90 cells, 1.17 USD, 121 minutes of run time summed over cells (about 40 minutes wall time at parallelism 3)
- sonnet (heldout): 90 cells, 9.43 USD, 62 minutes of run time summed over cells (about 21 minutes wall time at parallelism 3)
- all: 10.60 USD, 183 minutes summed over cells

Cost on the SDK path is list price; a CLI run on a subscription or another tier will report different numbers.

## What differs on a rerun

- Model variance: the same cell can score differently on another run. The per-cell spread inside this folder (min-max in the tables) shows the size of it.
- Cost, turns and time vary with the run path (SDK shim or CLI) and the day.
- F6 agreement: not measured (F6 was not run, see SUMMARY.md)
