SCOPED RESULT SENTENCE: NOT A VALID MEASUREMENT, NO CLAIM. On 2026-10-23, `claude-sonnet-5-5`, subscription path, six arms, 3 runs per task: on the public set Z1 to Z6 ours scored 26.00 of 36 against the baseline's 28.00 (ours minus best other -2.00, 95 percent bootstrap interval [-4.00, -1.00]); on the new held-out set d ours scored 29.67 of 30 against courier's 27.33 (+2.33, interval [-0.33, 4.00], which includes zero). Claim I1 is not met on either set. Besides, every cell ran in a folder below /Users/efe, so the owner's global CLAUDE.md (caveman style, commit format, RTK) was loaded as project memory in every arm (see ISOLATION.md); the numbers are kept as a record, not as a result. Haiku and Opus (F9) and the sampled re-runs (F6-runs) were not completed.

<!-- score.py begin -->
## sonnet, held-out set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| d1 (6) | 5.67 [6, 5, 6] (5-6, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 3.33 [2, 6, 2] (2-6, n=3) | 2.00 [2, 2, 2] (2-2, n=3) |
| d2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| d3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| d4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| d5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 29.67 | 26.00 | 26.00 | 26.00 | 27.33 | 26.00 |

### Cost

| measure | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| mean cost USD per run | 0.120 | 0.141 | 0.122 | 0.185 | 0.133 | 0.190 |
| cost vs baseline | 0.85 | 1.00 | 0.86 | 1.31 | 0.94 | 1.35 |
| mean turns per run | 6.2 | 6.3 | 5.3 | 9.1 | 6.4 | 8.4 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- d1 (max 6): ours 5.67; baseline 2.00: 5.67 > 2.00 ok; knock 2.00: 5.67 > 2.00 ok; knock-inv 2.00: 5.67 > 2.00 ok; courier 3.33: 5.67 > 3.33 ok; courier-inv 2.00: 5.67 > 2.00 ok => Rule B PASS
- d2 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- d3 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- d4 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- d5 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 29.67 of 30; lost 0.33
- baseline: total of means 26.00 of 30; lost 4.00
- knock: total of means 26.00 of 30; lost 4.00
- knock-inv: total of means 26.00 of 30; lost 4.00
- courier: total of means 27.33 of 30; lost 2.67
- courier-inv: total of means 26.00 of 30; lost 4.00
- best other arm: courier (total 27.33, lost 2.67); 0.8 x 2.67 = 2.13; ours lost 0.33 <= 2.13 is true => Rule A PASS

Rule B-prime (frozen in docs/HEAD-TO-HEAD.md, section Round 6; EVIDENCE-SPEC Win rule): ours is strictly higher than every other arm on every task,
or at the ceiling together with the best arm, except on at most one task; on that one task the deficit to the best other arm is at most 0.34.

- exception tasks: 0; => Rule B-prime PASS

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- ours 0.119910 USD <= baseline 0.140935 USD is true => Cost rule PASS

GATE sonnet (held-out set): PASS (PASS only when Rule A, Rule B on every task and the cost rule all pass)

GATE-B-PRIME sonnet (held-out set): see Rule B-prime above; with Rule A and the cost rule: PASS

## sonnet, public set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| z1 (6) | 4.67 [4, 5, 5] (4-5, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| z2 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 4.33 [4, 5, 4] (4-5, n=3) | 3.67 [5, 3, 3] (3-5, n=3) | 3.67 [4, 3, 4] (3-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 3.67 [4, 3, 4] (3-4, n=3) |
| z3 (6) | 3.00 [3, 3, 3] (3-3, n=3) | 4.67 [4, 4, 6] (4-6, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 5.33 [6, 5, 5] (5-6, n=3) | 5.33 [5, 6, 5] (5-6, n=3) | 5.00 [5, 4, 6] (4-6, n=3) |
| z4 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 3.33 [2, 4, 4] (2-4, n=3) | 3.33 [2, 4, 4] (2-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 3.33 [4, 2, 4] (2-4, n=3) | 2.00 [2, 2, 2] (2-2, n=3) |
| z5 (6) | 5.33 [5, 6, 5] (5-6, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 3.67 [4, 3, 4] (3-4, n=3) | 3.67 [3, 4, 4] (3-4, n=3) | 4.33 [5, 4, 4] (4-5, n=3) | 4.00 [5, 4, 3] (3-5, n=3) |
| z6 (6) | 5.00 [5, 5, 5] (5-5, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 5.00 [5, 6, 4] (4-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 4.67 [5, 5, 4] (4-5, n=3) | 4.67 [4, 5, 5] (4-5, n=3) |
| total of means (36) | 26.00 | 28.00 | 25.67 | 27.67 | 27.67 | 25.33 |

### Cost

| measure | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| mean cost USD per run | 0.153 | 0.174 | 0.165 | 0.225 | 0.169 | 0.220 |
| cost vs baseline | 0.88 | 1.00 | 0.95 | 1.29 | 0.97 | 1.26 |
| mean turns per run | 7.2 | 4.8 | 5.3 | 9.8 | 4.9 | 8.1 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- z1 (max 6): ours 4.67; baseline 6.00: 4.67 not above, FAIL; knock 6.00: 4.67 not above, FAIL; knock-inv 6.00: 4.67 not above, FAIL; courier 6.00: 4.67 not above, FAIL; courier-inv 6.00: 4.67 not above, FAIL => Rule B FAIL
- z2 (max 6): ours 4.00; baseline 4.33: 4.00 not above, FAIL; knock 3.67: 4.00 > 3.67 ok; knock-inv 3.67: 4.00 > 3.67 ok; courier 4.00: 4.00 not above, FAIL; courier-inv 3.67: 4.00 > 3.67 ok => Rule B FAIL
- z3 (max 6): ours 3.00; baseline 4.67: 3.00 not above, FAIL; knock 4.00: 3.00 not above, FAIL; knock-inv 5.33: 3.00 not above, FAIL; courier 5.33: 3.00 not above, FAIL; courier-inv 5.00: 3.00 not above, FAIL => Rule B FAIL
- z4 (max 6): ours 4.00; baseline 3.33: 4.00 > 3.33 ok; knock 3.33: 4.00 > 3.33 ok; knock-inv 4.00: 4.00 not above, FAIL; courier 3.33: 4.00 > 3.33 ok; courier-inv 2.00: 4.00 > 2.00 ok => Rule B FAIL
- z5 (max 6): ours 5.33; baseline 4.00: 5.33 > 4.00 ok; knock 3.67: 5.33 > 3.67 ok; knock-inv 3.67: 5.33 > 3.67 ok; courier 4.33: 5.33 > 4.33 ok; courier-inv 4.00: 5.33 > 4.00 ok => Rule B PASS
- z6 (max 6): ours 5.00; baseline 5.67: 5.00 not above, FAIL; knock 5.00: 5.00 not above, FAIL; knock-inv 5.00: 5.00 not above, FAIL; courier 4.67: 5.00 > 4.67 ok; courier-inv 4.67: 5.00 > 4.67 ok => Rule B FAIL

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 26.00 of 36; lost 10.00
- baseline: total of means 28.00 of 36; lost 8.00
- knock: total of means 25.67 of 36; lost 10.33
- knock-inv: total of means 27.67 of 36; lost 8.33
- courier: total of means 27.67 of 36; lost 8.33
- courier-inv: total of means 25.33 of 36; lost 10.67
- best other arm: baseline (total 28.00, lost 8.00); 0.8 x 8.00 = 6.40; ours lost 10.00 <= 6.40 is false => Rule A FAIL

Rule B-prime (frozen in docs/HEAD-TO-HEAD.md, section Round 6; EVIDENCE-SPEC Win rule): ours is strictly higher than every other arm on every task,
or at the ceiling together with the best arm, except on at most one task; on that one task the deficit to the best other arm is at most 0.34.

- exception task z1: deficit to the best other arm 1.33
- exception task z2: deficit to the best other arm 0.33
- exception task z3: deficit to the best other arm 2.33
- exception task z4: deficit to the best other arm 0.00
- exception task z6: deficit to the best other arm 0.67
- exception tasks: 5; => Rule B-prime FAIL

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- ours 0.153002 USD <= baseline 0.174009 USD is true => Cost rule PASS

GATE sonnet (public set): FAIL (PASS only when Rule A, Rule B on every task and the cost rule all pass)

GATE-B-PRIME sonnet (public set): see Rule B-prime above; with Rule A and the cost rule: FAIL
<!-- score.py end -->

## Departures from the frozen protocol

TO BE WRITTEN BY THE CONTROLLER
