# Final-measurement protocol, round 8 (frozen 2026-10-23, before the first run of this measurement)

Frozen under the owner decisions of 2026-10-23 (spec section 2b and the coordinator messages of that day). This file is committed and pushed before any measurement cell runs. Nothing below is edited after a result is seen; later facts go in `SUMMARY.md` of the evidence folder as departures.
Evidence folder: `bench/head-to-head/results/round8-final/` (standard: `EVIDENCE-SPEC.md`, 11 items, plus its statistics and cost section).

## Claim

I1 (launch claim, Sonnet only): in the public set and in the held-out set d, separately, the 95 percent percentile bootstrap interval of (ours total minus the best other arm's total) lies entirely above zero. Totals are sums of per-task means over 3 runs. 10,000 resamples, seed 7, repetitions of each task resampled independently per arm, the best other arm re-chosen inside every resample (`bench/head-to-head/tools/devgate-bootstrap.py`, run per set on the Sonnet results). The claim carries its scope (arms, tasks, model, date, path) and nothing wider. If either interval includes zero, the claim is not made for that set and `SUMMARY.md` says so in the first paragraph.
Reported alongside, not deciding the launch: per-task table, Rule A (our lost points at most 80 percent of the best other arm's), Rule B (strictly above every other arm on every task, at the ceiling together when another arm is), Rule B-prime (verbatim from `EVIDENCE-SPEC.md`: strictly higher or at the ceiling on every task except at most one, where the deficit to the best other arm is at most 0.34 points), cost ratio to the baseline, turns, wall time. A perfect score is not a target; nothing is lowered or shaped.
F9 (Haiku and Opus, descriptive): totals only, no pass or fail, no claim.

## Sets

- Public set: Z1 to Z6 (`bench/head-to-head/prompts/z1.txt` to `z6.txt`, checkers `checkers/z1.mjs` to `z6.mjs`, criteria `tasks/Z.md`, labels `labels.json`), frozen since 2026-10-22. The Z checkers load the produced module with a millisecond timestamp suffix (`checkers/lib.mjs`), which can share a module instance between two criteria loaded in the same millisecond (found in round 7). The checkers are not changed. To measure its effect, every set is scored twice (see Grading).
- Held-out set d: five tasks d1 to d5 written by a fresh Sonnet agent (`claude-sonnet-5-5`, subagent, no tools beyond file access in its own folder, no network) that was shown only `WRITER-SPEC.md` (a one-sentence description of the user's job, "My AI agent messages people at night and past their daily limit, and I cannot tell which rule should have stopped it", the task template and the checker conventions; the same text round 5 used) and the checker helper files. It was not shown the product code, `HEAD-TO-HEAD.md`, any earlier set or result, or any loss class. Its folder is outside the repository (`~/claude-kredi-runs/2026-10-23/pg-ho-d/writer/out`), mode 700; the controller never opened a prompt, criterion or reference of it; it ran each checker on the writer's references and read only the score lines (good reference 6 of 6 on every task; broken references 4, 5, 4, 4, 4 and 4, 1, 4, 4, 3 of 6). The checker loader of this set uses a random module suffix. Seal hash (SHA-256 over the sorted list of per-file SHA-256 lines of the 30 files): `e2ebb9fabb361f71e72d81943288c4612f4d97c8d6572934fb9603b5b734bcc5`. After the measurement it is copied into the evidence folder (`tasks/`) and stops being held-out.

## Arms

`ours` (immutable `git archive` of commit `5fe287e8472ec32e4c357e9b0c22a484466a3ad0`, the build of the development gate; the shipped paths are unchanged by later commits), `baseline` (empty plugin), `knock` and `knock-inv` (Knock skills, MIT, pinned `cc99682ed74ee34198602c7d28569bd1c5f309d3`), `courier` and `courier-inv` (Courier skills, MIT, pinned `18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132`, skill text only, no MCP, no key). Invoked arms start the prompt with the sentence of `run.mjs`. Vaara is not run (rulings in `HEAD-TO-HEAD.md`). Rival code runs only from `git archive` copies.

## Runs

- Model `claude-sonnet-5-5`, 3 runs per task and arm, every cell run fresh on the same path in this measurement; no cell of any earlier round or of the development gate is reused. Public set 6 tasks x 6 arms x 3 = 108 cells; held-out d 5 x 6 x 3 = 90 cells.
- Path: the owner's Claude Code subscription through `~/claude-kredi-runs/sub-shim/claude` (`H2H_CLAUDE_BIN`, `H2H_SUB=1`), CLI 2.1.308, `--setting-sources project --plugin-dir <arm> --strict-mcp-config`, parallelism 3, the runner's hash guard on the real hooks and MCP servers before and after every cell, the probe of `probe.mjs` before the first cell. Started with `bench/head-to-head/dev/run-devgate.sh`-style commands through `rerun.sh` (`--commit 5fe287e...`, `--arms ours,baseline,knock,knock-inv,courier,courier-inv`, `--reps 3`), one set at a time.
- A cell that fails for a usage limit, session limit, authentication error or API error (HTTP 429, 401, 403, `is_error` with a zero-second result) is never graded: it is removed, kept in the list of invalid cells, and run again from scratch after the limit resets. The runner stops on such an error.

## Grading

All criteria of both sets are decided by the task checkers (scripts that run the produced code with injected users, clocks and state); no model grades any cell, so the five-vote reason-first model grading of the owner decision does not apply, and the scripts stay the judge. Every set is scored twice by `score.mjs` (two independent passes over the same produced code). The first pass is the score of record; the number of cells and criteria on which the second pass differs is reported (this is the effect of the loader race in the public checkers).

## F6, in two parts

- F6-grader: the second scoring pass above covers every cell, not a 10 percent sample; it passes if no cell differs from the first pass by more than 1 point and criterion agreement is at least 90 percent. A failure is reported and the affected set is stated as unstable; it does not change a score of record.
- F6-runs: 10 percent of the Sonnet cells of each set (11 of 108 and 9 of 90, drawn with `random.Random(7).sample` over the sorted cell names) are run once more on fresh fixtures, same path. Reported descriptively: the count whose re-run score lies within the min-max of the cell's three runs. Not pass or fail.

## F9, descriptive

Models `claude-haiku-5-5` and `claude-opus-5-5`, 1 run per task, arms `ours`, `baseline` and the Sonnet-best other arm of each set (chosen from the Sonnet totals after the Sonnet runs), on both sets: 11 tasks x 3 arms x 2 models = 66 cells. Totals reported per model and set, with no claim and no gate. If the Opus model id is not accepted by the path, the cells are not run and the report says so.

## Spending and stopping

Every cell's `total_cost_usd` is summed (list-price estimate; the subscription is what is charged) by set, arm and model; the totals go in `SUMMARY.md`. Call estimate: 108 + 90 Sonnet + 20 F6-runs + 66 F9 = 284 `claude -p` calls, plus 2 probes. A usage or session limit stops the run; the report says what remains. The measurement is run once; a failed claim is published as it is.

## Evidence

`SUMMARY.md` (scoped sentence, per-task tables with every run, intervals, rules A, B, B-prime, cost, departures), `PROTOCOL.md` (link to this file and the commit that froze it), `arms.json`, `env.json`, `tasks/` (including the held-out set d and who wrote it and what it was shown), `runs/` (redacted final answers and traces with `cost.json`), `grades/` (checker output of both passes), `score.py` and `score.py --check SUMMARY.md`, `REPRODUCE.md`, `VERIFY.md`, `SHA256SUMS`. Built with `bench/head-to-head/tools/build-evidence.py`.
