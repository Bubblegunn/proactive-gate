DEVELOPMENT GATE, iteration 1 (build `62c1340`, 2026-10-23): ours x3 on the seen round-5 held-out set g1 to g5, both models, SDK path, scored by the task checkers: Haiku 29.33 and Sonnet 30.00 of 30 (g3 on Haiku 5.33). This is a development measurement of a set that was already seen; it does not enter any score table or claim. Other arms are not rerun here: the comparison is with the published round-5 scores in `results/round5-heldout/SUMMARY.md` (best rival: Haiku g1 3.00, g2 to g5 6.00; Sonnet g1 5.00, g2 to g5 6.00). Rule A, Rule B and cost lines below are n/a or meaningless without rival cells.

<!-- score.py begin -->
## haiku, held-out set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours |
|---|---|
| g1 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g2 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g3 (6) | 5.33 [4, 6, 6] (4-6, n=3) |
| g4 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g5 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 29.33 |

### Cost

| measure | ours |
|---|---|
| mean cost USD per run | 0.010 |
| cost vs baseline | n/a |
| mean turns per run | 6.0 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- g1 (max 6): ours 6.00;  => Rule B PASS
- g2 (max 6): ours 6.00;  => Rule B PASS
- g3 (max 6): ours 5.33;  => Rule B PASS
- g4 (max 6): ours 6.00;  => Rule B PASS
- g5 (max 6): ours 6.00;  => Rule B PASS

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 29.33 of 30; lost 0.67
- Rule A: n/a (ours or every other arm is incomplete)

Rule B-prime (frozen in docs/HEAD-TO-HEAD.md, section Round 6; EVIDENCE-SPEC Win rule): ours is strictly higher than every other arm on every task,
or at the ceiling together with the best arm, except on at most one task; on that one task the deficit to the best other arm is at most 0.34.

- exception tasks: 0; => Rule B-prime PASS

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- cost: n/a (ours or baseline has no cost data)

GATE haiku (held-out set): n/a (PASS only when Rule A, Rule B on every task and the cost rule all pass)

GATE-B-PRIME haiku (held-out set): see Rule B-prime above; with Rule A and the cost rule: n/a

## sonnet, held-out set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours |
|---|---|
| g1 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g2 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g3 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g4 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| g5 (6) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 30.00 |

### Cost

| measure | ours |
|---|---|
| mean cost USD per run | 0.091 |
| cost vs baseline | n/a |
| mean turns per run | 5.4 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- g1 (max 6): ours 6.00;  => Rule B PASS
- g2 (max 6): ours 6.00;  => Rule B PASS
- g3 (max 6): ours 6.00;  => Rule B PASS
- g4 (max 6): ours 6.00;  => Rule B PASS
- g5 (max 6): ours 6.00;  => Rule B PASS

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 30.00 of 30; lost 0.00
- Rule A: n/a (ours or every other arm is incomplete)

Rule B-prime (frozen in docs/HEAD-TO-HEAD.md, section Round 6; EVIDENCE-SPEC Win rule): ours is strictly higher than every other arm on every task,
or at the ceiling together with the best arm, except on at most one task; on that one task the deficit to the best other arm is at most 0.34.

- exception tasks: 0; => Rule B-prime PASS

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- cost: n/a (ours or baseline has no cost data)

GATE sonnet (held-out set): n/a (PASS only when Rule A, Rule B on every task and the cost rule all pass)

GATE-B-PRIME sonnet (held-out set): see Rule B-prime above; with Rule A and the cost rule: n/a
<!-- score.py end -->

## Departures from the frozen protocol

- Development gate only; see `results/round6-heldout-c/SUMMARY.md` for the round.
