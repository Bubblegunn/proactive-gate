# Development-gate protocol, round 9 (frozen 2026-10-23 before the first round-9 cell)

Reason and context: `docs/HEAD-TO-HEAD.md` "Round 9". The round-8 gate used a set (k) whose writer was shown a list of difficulty areas and sets already read; the round-8 measurement then lost the public set. This gate uses sets
written by three fresh Sonnet agents (p, q, r) that were shown only `WRITER-SPEC.md` (a one-sentence description of the user's job, the task template and the checker conventions) and never the product code, its documents, any earlier set or result, or any list of areas.
Each set has 5 tasks, a good reference (6 of 6) and two broken ones, validated by the writer and re-run by the controller before commit (good 6 of 6 on all 15; broken 1 to 5 of 6). The loader of these checkers uses a random module suffix.

## Isolation

Every work directory is under `/private/tmp/pg-r9/` (run cwd, fixtures, `_setup`). The wrapper refuses a cwd below /Users/efe. Reason: Claude Code loads the CLAUDE.md of every ancestor directory; the round-8 cells did not meet this.
Check after the run: the string `caveman` must not occur in any transcript (`grep -l caveman runs/*.jsonl` empty); if it does, the set is void and is run again.

## Arms and runs

Model `claude-sonnet-5-5` only (the launch claim rests on Sonnet; Haiku is descriptive in the final measurement). Subscription path through `~/claude-kredi-runs/sub-shim/claude`, `H2H_SUB=1`, parallelism 3, hash guard on real hooks and MCP servers, probe before the first cell.
- Lead sets p, q, r: `ours` (immutable `git archive` of the commit under test), `baseline`, `courier`, `courier-inv` (Courier skills pinned `18c7bcb`, skill text only), 3 runs per task: 3 sets x 5 tasks x 4 arms x 3 = 180 cells.
- Regression sets, `ours` only, 3 runs per task: k, r5, c, d (all four have been read or scored; none counts as held-out): 4 x 5 x 3 = 60 cells.
- Knock is not run in the gate (it was never ahead of Courier or the baseline on Sonnet); it runs in the final measurement.
- A cell that fails with a usage limit, session limit or authentication error (HTTP 429/401/403, zero-second result) is never graded: it is set aside and run again from scratch. The runner stops on it.
- Scoring: the task checkers only. No model grades a cell.

## Decision rules ("clear lead"), fixed before the run

- G1 (pooled lead): over the 15 tasks of p, q, r together (maximum 90), the 95 percent percentile bootstrap interval of (ours total minus best other arm total) lies entirely above zero (`tools/devgate-bootstrap.py`, 10,000 resamples, seed 7, repetitions resampled per task and arm, best other arm re-chosen inside every resample).
- G2 (every set): on each of p, q and r separately, ours total is at least the best other arm's total (the point estimate of the difference is not negative).
- G3 (no lost task): on each of the 15 tasks ours mean is at least the best other arm's mean, except at most one task per set where the deficit is at most 0.34.
- G4 (no regression): ours total on k, r5, c and d is at least 26.33, 29.00, 28.00 and 27.33 (the best other arm's totals in the round-8 tables of those sets; d's from the contaminated round-8 run, used only as a floor).
- G5 (cost): ours mean `total_cost_usd` per run on p, q, r is not above the baseline's, and ours mean turns per run is at most the baseline's plus 1.0.
- G6 (isolation): no transcript contains `caveman`.
If all six hold, the final measurement may start (a new protocol is frozen first, with a held-out set from yet another fresh writer: set e, sealed, hash `4d7b17a9e6ae5d1016e86e85302239d5dccda9b0e6641da5f6deae04a4a18573` over the 30 files). If not: at most three iterations; each is a general fix with its ruling committed before the code; ours is re-run on every set the change can touch; rival and baseline cells are reused only inside this gate.
A perfect score is not a target. Do not iterate to close the last points once G1 to G6 hold.

## Calls and cost

Probe 1; first iteration 180 + 60 = 240 `claude -p` calls; each further iteration 15 tasks x 3 + 60 = 105. Worst case, three iterations: 1 + 240 + 105 + 105 = 451. Expected list price of the first iteration: 20 to 40 USD (the subscription is what is charged).
