# Reproduce

1. `git clone` the repo, `git checkout plugin-leadership`. Needs Node 22+, the `claude` CLI (2.1.308) or the SDK shim, and an API key (about 3.2 USD and 40 minutes per iteration).
2. One iteration: `H2H_TASKS_DIR=<repo>/bench/head-to-head/results/round6-heldout-c/tasks H2H_CLAUDE_BIN=<claude> bash bench/head-to-head/rerun.sh --commit 6bdfc6c --model claude-haiku-5-5 --reps 3 --arms ours --tasks g1,g2,g3,g4,g5 --out <dir>`
   (same with `round5-heldout/tasks` and with `claude-sonnet-5-5`).
3. Rescore the published cells: `python3 score.py --check SUMMARY.md`.
Model variance: the same build gave Haiku round-5 g3 6/6 in iteration 1 and 6, 2, 6 in iteration 3; see the table. The checker race in NOTES.md adds variance on c g2.
