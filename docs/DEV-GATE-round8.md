# Development-gate protocol, round 8 (frozen 2026-10-23 before the first run)

Scope: development only. Nothing in this protocol enters a score table of the final measurement, and no claim of "first" or "best" is made from it. The final measurement (spec section 2b) starts
only if this gate passes on both models. Decision rules below are fixed before any cell runs; results seen later do not change them.

## Sets

| set | tasks | status | used for |
|---|---|---|---|
| k | `bench/head-to-head/dev/k/` k1 to k5 (checkers, references, labels; commit `development set k`) | written by a fresh Sonnet agent that never saw the product code; committed before any run; never part of any public or held-out set | the lead test (P1, P2, P4) |
| r5 | the round-5 set g1 to g5 (published in the repository since round 5) | already read and burned | regression check, ours only (P3) |
| c | held-out c g1 to g5 (published in round 6) | already read and burned | regression check, ours only (P3) |

Not used: the public set Z1 to Z6 (`tasks.json`/`tasks/Z.md`), any `heldout*` branch or folder, any set that nobody has read. The sets r5 and c are used the way round 7 used them (development, not scoring).

## Arms and runs

- Models: `claude-sonnet-5-5` and `claude-haiku-5-5`, each judged on its own.
- Set k: four arms, 3 runs per task and arm: `ours` (the commit under test, as an immutable `git archive` copy), `baseline` (empty plugin), `courier` (Courier skills, pinned `18c7bcb`, skill text only, natural prompt), `courier-inv` (same, prompt names the skill). Courier is the best rival on Sonnet in round 5 and ties for best on Haiku; Knock is not run (no Knock arm was ahead of Courier on either model; it stays in the final measurement).
- Sets r5 and c: `ours` only, 3 runs per task. References are the published best-other totals: r5 Haiku 27.00, r5 Sonnet 29.00 (courier), c Haiku 28.00 (baseline); c Sonnet has no published rival run, so the reference is 28.00 (the baseline level on sets of this kind, chosen here before the run).
- Path: the owner's Claude Code subscription through `~/claude-kredi-runs/sub-shim/claude` (`H2H_CLAUDE_BIN`, `H2H_SUB=1`; the wrapper forces its own HOME; the runner passes `--setting-sources project --plugin-dir <arm> --strict-mcp-config`). Parallelism 3. The runner hashes the real `hooks` and `mcpServers` before and after every cell and stops on a change. A cell that fails for a usage limit, session limit, authentication or API error is never graded; the run stops and is reported.
- Rival code runs only from `git archive` copies under the run folder. Scoring: the task checkers only (no model grader), one `score.mjs` call per set and model.

## Decision rules (all per model; "clear lead" needs every one on both models)

- P1 (lead on k): the 95 percent percentile bootstrap interval of (ours total minus best other arm total) on set k lies entirely above zero. `bench/head-to-head/tools/devgate-bootstrap.py`: totals are sums of per-task means (maximum 30); repetitions of each task are resampled with replacement independently per arm; the best other arm is re-chosen inside every resample; 10000 resamples, seed 7.
- P2 (no task lost on k): on every task of k ours is at least the best other arm's mean, except at most one task where the deficit is at most 0.34 points.
- P3 (no regression on seen sets): ours total on r5 and on c is at least the reference above, per model.
- P4 (cost): ours mean `total_cost_usd` per run on k is not above the baseline's on the same model, and ours mean turns per run is at most the baseline's plus 1.0.
- A cell whose bot.mjs does not exist or whose checker produces no result counts as the score it gets (0); it is reported.

If the gate passes on both models, the orchestrator-level decision is to freeze the final-measurement protocol. If not: at most three iterations in total. Each iteration is a general fix (no task-specific entry), tested and reviewed, with its ruling committed before the code, then ours is re-run on every set that the change can touch (practically all of them); the rival and baseline cells on k are not re-run because their inputs do not change (same path, same pinned code); this reuse is allowed only inside this gate.

## Call estimate (`claude -p` calls)

| step | calls |
|---|---|
| probe (one Haiku cell per path, then one Sonnet ours cell) | 3 |
| iteration 1, set k: 4 arms x 5 tasks x 3 runs x 2 models | 120 |
| iteration 1, sets r5 and c: ours x 2 sets x 5 tasks x 3 runs x 2 models | 60 |
| each further iteration (ours only: k 30 + r5 and c 60) | 90 |
| worst case, three iterations | 3 + 180 + 90 + 90 = 363 |

Cost at list price (the CLI's estimate; the subscription is what is charged): from round 5 about 0.09 USD per Sonnet cell and 0.02 USD per Haiku cell; set k is larger (round-3 Z tasks cost 0.14 to 0.27 USD per Sonnet cell), so the first iteration is expected in the range 15 to 30 USD of list price.

## Evidence

Each iteration writes `bench/head-to-head/results/round8-devgate/iter<N>/` with `COMMIT`, `PROBE.txt`, per-set `results.json`, `table-outcome.md`, the bootstrap output and a short `NOTES.md`; the gate verdict goes in `docs/HEAD-TO-HEAD.md` under "Results, round 8 (development gate)". Transcripts stay out of git (size); their SHA-256 sums are committed.
