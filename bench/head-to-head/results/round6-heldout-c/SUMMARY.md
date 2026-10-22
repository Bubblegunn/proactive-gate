Scoped result: on a new held-out set c of 5 tasks (g1 to g5, 6 outcome criteria each) with 6 arms (ours, baseline, Knock plain and invoked, Courier plain and invoked), 3 runs per cell, Claude Agent SDK path, 2026-10-23, build `671b716`, on Haiku (`claude-haiku-5-5`) ours scores 29.00 of 30 against 28.00 for the best other arm (baseline), wins Rule A and the cost rule (0.84 times the baseline), but FAILS Rule B and Rule B-prime because on g3 ours is 5.00 against 6.00 (deficit 1.00, limit 0.34); Sonnet was not run (controller spending cap), The public set Z1 to Z6 was not completed; F6 and F9 were not run, so no claim of "first" or "best" is made.

<!-- score.py begin -->
## haiku, held-out set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| g1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.00 [3, 6, 6] (3-6, n=3) | 5.00 [6, 6, 3] (3-6, n=3) | 5.67 [6, 5, 6] (5-6, n=3) | 5.67 [6, 6, 5] (5-6, n=3) | 5.00 [3, 6, 6] (3-6, n=3) |
| g2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.33 [6, 6, 4] (4-6, n=3) | 5.00 [5, 6, 4] (4-6, n=3) | 4.67 [4, 5, 5] (4-5, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) |
| g3 (6) | 5.00 [6, 3, 6] (3-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 5.00 [6, 6, 3] (3-6, n=3) | 4.00 [3, 3, 6] (3-6, n=3) | 4.00 [3, 6, 3] (3-6, n=3) | 5.00 [6, 3, 6] (3-6, n=3) |
| g4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 5.67 [6, 5, 6] (5-6, n=3) | 5.33 [6, 5, 5] (5-6, n=3) |
| total of means (30) | 29.00 | 28.00 | 27.00 | 26.00 | 27.00 | 27.00 |

### Cost

| measure | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| mean cost USD per run | 0.010 | 0.012 | 0.013 | 0.012 | 0.012 | 0.012 |
| cost vs baseline | 0.84 | 1.00 | 1.07 | 0.97 | 1.03 | 1.03 |
| mean turns per run | 6.3 | 7.4 | 7.5 | 9.3 | 7.4 | 7.9 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- g1 (max 6): ours 6.00; baseline 5.00: 6.00 > 5.00 ok; knock 5.00: 6.00 > 5.00 ok; knock-inv 5.67: 6.00 > 5.67 ok; courier 5.67: 6.00 > 5.67 ok; courier-inv 5.00: 6.00 > 5.00 ok => Rule B PASS
- g2 (max 6): ours 6.00; baseline 5.33: 6.00 > 5.33 ok; knock 5.00: 6.00 > 5.00 ok; knock-inv 4.67: 6.00 > 4.67 ok; courier 5.67: 6.00 > 5.67 ok; courier-inv 5.67: 6.00 > 5.67 ok => Rule B PASS
- g3 (max 6): ours 5.00; baseline 6.00: 5.00 not above, FAIL; knock 5.00: 5.00 not above, FAIL; knock-inv 4.00: 5.00 > 4.00 ok; courier 4.00: 5.00 > 4.00 ok; courier-inv 5.00: 5.00 not above, FAIL => Rule B FAIL
- g4 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g5 (max 6): ours 6.00; baseline 5.67: 6.00 > 5.67 ok; knock 6.00: both at maximum 6 ok; knock-inv 5.67: 6.00 > 5.67 ok; courier 5.67: 6.00 > 5.67 ok; courier-inv 5.33: 6.00 > 5.33 ok => Rule B PASS

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 29.00 of 30; lost 1.00
- baseline: total of means 28.00 of 30; lost 2.00
- knock: total of means 27.00 of 30; lost 3.00
- knock-inv: total of means 26.00 of 30; lost 4.00
- courier: total of means 27.00 of 30; lost 3.00
- courier-inv: total of means 27.00 of 30; lost 3.00
- best other arm: baseline (total 28.00, lost 2.00); 0.8 x 2.00 = 1.60; ours lost 1.00 <= 1.60 is true => Rule A PASS

Rule B-prime (frozen in docs/HEAD-TO-HEAD.md, section Round 6; EVIDENCE-SPEC Win rule): ours is strictly higher than every other arm on every task,
or at the ceiling together with the best arm, except on at most one task; on that one task the deficit to the best other arm is at most 0.34.

- exception task g3: deficit to the best other arm 1.00
- exception tasks: 1; => Rule B-prime FAIL

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- ours 0.010065 USD <= baseline 0.012021 USD is true => Cost rule PASS

GATE haiku (held-out set): FAIL (PASS only when Rule A, Rule B on every task and the cost rule all pass)

GATE-B-PRIME haiku (held-out set): see Rule B-prime above; with Rule A and the cost rule: FAIL
<!-- score.py end -->

## Departures from the frozen protocol

- Sonnet (`claude-sonnet-5-5`) was not run for held-out c: the session's hard spending cap (7 USD for the controller; the meter also counted the benchmark runs' API spend) did not leave room for the 90-cell Sonnet batch (about 9.5 USD in round 5). The protocol asked for both models; this folder therefore covers Haiku only. The Sonnet gate for this build is not measured.
- `tools/score_template.py` was extended after the protocol freeze to print Rule B-prime and a second gate line. It implements the frozen text; no criterion, checker, task, label or Rule A/B/cost line changed.
- Scoring is by checker scripts (one `score.mjs` call for all cells); there is no model grader, so there are no votes or shuffled order (frozen protocol item 3).
- The held-out writer's first attempt (cost 0.38 USD) wrote no file because the headless permission mode refused writes; a second attempt (0.30 USD) wrote prompts and one checker and stopped at node commands; the session was resumed with bypassed permissions inside the scratch folder `/tmp/r6/writer` (0.64 USD) and finished. The controller did not read prompts or criteria before the gate; it ran the checkers on the references and printed scores only (good 6 of 6 on every task; broken references 0 to 5).
- Post-hoc reading (not a rule): the failing g3 cell of ours (run 2, 3 of 6) returned its refusals as full sentences (skill rule 8: "a plain sentence, never an internal code alone") although the task asks for a short snake_case code, and added a block the task did not state ("EU rules require" an explicit opt-in). The first is a conflict between rule 8 and the requested return shape; the second is the rule-2(d) default for promotions with no consent field. Both are general classes for a next round; the product was not changed after the gate.
- Development gate (ours x3 on the round-5 set, both models; not part of any score table): iteration 1 on `62c1340`: Haiku 29.33, Sonnet 30.00 (cost 1.51 USD); iteration 2 on `671b716`: Haiku 30.00, Sonnet 30.00 (1.57 USD). Passed at iteration 2 (strictly above the best rival on Haiku g1 and Sonnet g1, level at the ceiling elsewhere). Folders `results/round6-devgate-iter1`, `results/round6-devgate-iter2`.
- F6 and F9 were not run: the gate did not pass.

