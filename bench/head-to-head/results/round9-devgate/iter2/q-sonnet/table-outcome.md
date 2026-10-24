Commit under test: e9ebdca9dadca16df50c2e6cef70f0f1d8afa90c

### Outcome criteria only (labels.json)

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| q1 (6) | 4.67 [6, 6, 2] (2-6, n=3) | 4.00 [4, 6, 2] (2-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| q2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| q3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| q4 (6) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [6, 5, 4] (4-6, n=3) |
| q5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 27.67 | 27.00 | 29.00 | 29.00 |

| measure | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.176 | 0.183 | 0.156 | 0.133 |
| cost vs baseline | 1.00 | 1.04 | 0.89 | 0.76 |
| mean wall time per run, seconds | 80 | 63 | 70 | 49 |
| mean turns per run | 4.6 | 6.3 | 4.1 | 5.0 |
| mean lines of code written (source files) | 135 | 135 | 139 | 246 |
| mean lines written (all text files) | 135 | 135 | 139 | 246 |
| runs whose solution mentions proactive-gate | 0/15 | 0/15 | 0/15 | 0/15 |
| Skill tool calls (sum) | 0 | 15 | 0 | 15 |
