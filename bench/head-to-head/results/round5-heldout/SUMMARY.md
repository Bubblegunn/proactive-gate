Scoped result: on a new held-out set of 5 tasks (g1 to g5, 6 outcome criteria each; 3 of the 5 tasks are saturated, every arm scores 6.00 on them) with 6 arms (ours, baseline, Knock plain and invoked, Courier plain and invoked) and 3 runs per cell, run on the Claude Agent SDK path on 2026-10-22 with build `5dbfaf3`, the gate PASSES on Haiku (`claude-haiku-5-5`: ours 28.00 of 30 against 27.00 for the best other arm) and FAILS on Sonnet (`claude-sonnet-5-5`: ours 27.00 against 29.00; ours lost g1 with 3.00 against 5.00, Rule A and the cost rule (1.02 times the baseline) fail); the public set Z1 to Z6, F6 and F9 were not run, so no claim of "first" or "best" is made.

<!-- score.py begin -->
## haiku, held-out set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| g1 (6) | 4.00 [3, 3, 6] (3-6, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 3.00 [3, 3, 3] (3-3, n=3) |
| g2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 4.33 [4, 3, 6] (3-6, n=3) | 4.33 [3, 6, 4] (3-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 3.67 [4, 3, 4] (3-4, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 28.00 | 25.33 | 25.33 | 27.00 | 24.67 | 27.00 |

### Cost

| measure | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| mean cost USD per run | 0.010 | 0.012 | 0.015 | 0.015 | 0.011 | 0.015 |
| cost vs baseline | 0.85 | 1.00 | 1.24 | 1.31 | 0.95 | 1.26 |
| mean turns per run | 6.9 | 7.0 | 7.3 | 10.5 | 6.4 | 9.0 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- g1 (max 6): ours 4.00; baseline 3.00: 4.00 > 3.00 ok; knock 3.00: 4.00 > 3.00 ok; knock-inv 3.00: 4.00 > 3.00 ok; courier 3.00: 4.00 > 3.00 ok; courier-inv 3.00: 4.00 > 3.00 ok => Rule B PASS
- g2 (max 6): ours 6.00; baseline 4.33: 6.00 > 4.33 ok; knock 4.33: 6.00 > 4.33 ok; knock-inv 6.00: both at maximum 6 ok; courier 3.67: 6.00 > 3.67 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g3 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g4 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g5 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 28.00 of 30; lost 2.00
- baseline: total of means 25.33 of 30; lost 4.67
- knock: total of means 25.33 of 30; lost 4.67
- knock-inv: total of means 27.00 of 30; lost 3.00
- courier: total of means 24.67 of 30; lost 5.33
- courier-inv: total of means 27.00 of 30; lost 3.00
- best other arm: knock-inv (total 27.00, lost 3.00); 0.8 x 3.00 = 2.40; ours lost 2.00 <= 2.40 is true => Rule A PASS

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- ours 0.010015 USD <= baseline 0.011816 USD is true => Cost rule PASS

GATE haiku (held-out set): PASS (PASS only when Rule A, Rule B on every task and the cost rule all pass)

## sonnet, held-out set

### Outcome score per task

Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.

| task (max) | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| g1 (6) | 3.00 [3, 3, 3] (3-3, n=3) | 5.00 [3, 6, 6] (3-6, n=3) | 4.00 [3, 6, 3] (3-6, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 5.00 [3, 6, 6] (3-6, n=3) | 4.00 [6, 3, 3] (3-6, n=3) |
| g2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.33 [6, 4, 6] (4-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 27.00 | 28.33 | 28.00 | 27.00 | 29.00 | 28.00 |

### Cost

| measure | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| mean cost USD per run | 0.095 | 0.093 | 0.095 | 0.118 | 0.095 | 0.133 |
| cost vs baseline | 1.02 | 1.00 | 1.02 | 1.26 | 1.02 | 1.43 |
| mean turns per run | 5.9 | 4.1 | 4.0 | 7.4 | 4.2 | 7.3 |

### Verdict

Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,
ours must be at the task maximum too (strictly above is impossible there).

- g1 (max 6): ours 3.00; baseline 5.00: 3.00 not above, FAIL; knock 4.00: 3.00 not above, FAIL; knock-inv 3.00: 3.00 not above, FAIL; courier 5.00: 3.00 not above, FAIL; courier-inv 4.00: 3.00 not above, FAIL => Rule B FAIL
- g2 (max 6): ours 6.00; baseline 5.33: 6.00 > 5.33 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g3 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g4 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS
- g5 (max 6): ours 6.00; baseline 6.00: both at maximum 6 ok; knock 6.00: both at maximum 6 ok; knock-inv 6.00: both at maximum 6 ok; courier 6.00: both at maximum 6 ok; courier-inv 6.00: both at maximum 6 ok => Rule B PASS

Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.
Pass when ours lost <= 0.8 x best other lost.

- ours: total of means 27.00 of 30; lost 3.00
- baseline: total of means 28.33 of 30; lost 1.67
- knock: total of means 28.00 of 30; lost 2.00
- knock-inv: total of means 27.00 of 30; lost 3.00
- courier: total of means 29.00 of 30; lost 1.00
- courier-inv: total of means 28.00 of 30; lost 2.00
- best other arm: courier (total 29.00, lost 1.00); 0.8 x 1.00 = 0.80; ours lost 3.00 <= 0.80 is false => Rule A FAIL

Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.

Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).
- ours 0.094736 USD <= baseline 0.093160 USD is false => Cost rule FAIL

GATE sonnet (held-out set): FAIL (PASS only when Rule A, Rule B on every task and the cost rule all pass)
<!-- score.py end -->

## Departures from the frozen protocol

- The protocol (`docs/HEAD-TO-HEAD.md`, section "Round 5", commit `6140b94`) did not say what to do with saturated tasks. HANDOFF-CLOUD.md says a task where every arm scores full marks is replaced by a harder variant. Tasks g3, g4 and g5 are saturated on both models and were not replaced, because the held-out set cannot change after it is seen. The superiority on Haiku therefore rests on g1 and g2 only.
- Harness changes during the round, none of them touching a task, a checker or the scoring: `5621c14` (H2H_CLAUDE_BIN and H2H_TASKS_DIR), `6de5e4a` (the shim's JSON has a space after the colon), and a fix that links `~/.anthropic_key*` into each throw-away HOME and stops the run when a cell has no result message. The owner's shim switched to a second key file (`ACTIVE_KEY`) while the Haiku batch ran; 44 Haiku cells and 90 Sonnet cells that ended after 0 seconds because the key file was missing were deleted without being graded and were run again. Cells of both batches therefore ran under two API keys (two organisations' credits); the model, the SDK path and the CLI version are the same.
- The protocol was written for the owner's statement that the only difference between the SDK and the CLI path is the `Artifact` tool and one skill. The measured difference is larger (see `env.json` and the protocol section). All arms ran on the SDK path.
- Post-hoc reading (after the gate, not part of any rule): on g1 the Sonnet cells of ours scored 3 in 3 of 3 runs because the generated function refused daytime marketing texts with a rule the task did not state (a required opt-out notice in the message body); criteria 2, 3 and 4 failed for that one reason. Knock-inv shows the same pattern (3 of 3). This is the class "added an unrequested block that stops a valid send"; it is not covered by the checklist rules of build `5dbfaf3`.
- F6 (independent 10 percent re-run) and F9 (Opus) were not run because the gate did not pass on Sonnet. Agreement between a re-run and these results is therefore not measured.
