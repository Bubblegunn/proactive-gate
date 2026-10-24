Commit under test: e9ebdca9dadca16df50c2e6cef70f0f1d8afa90c

### Outcome criteria only (labels.json)

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| p1 (6) | 2.00 [0, 0, 6] (0-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 0.00 [0, 0, 0] (0-0, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| p2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| p3 (6) | 4.67 [5, 4, 5] (4-5, n=3) | 5.33 [6, 5, 5] (5-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 4.67 [5, 4, 5] (4-5, n=3) |
| p4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| p5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 24.67 | 29.33 | 23.00 | 28.67 |

| measure | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.120 | 0.142 | 0.113 | 0.101 |
| cost vs baseline | 1.00 | 1.18 | 0.94 | 0.84 |
| mean wall time per run, seconds | 53 | 46 | 49 | 33 |
| mean turns per run | 5.1 | 6.0 | 4.7 | 4.9 |
| mean lines of code written (source files) | 124 | 115 | 112 | 291 |
| mean lines written (all text files) | 124 | 115 | 112 | 291 |
| runs whose solution mentions proactive-gate | 0/15 | 0/15 | 0/15 | 0/15 |
| Skill tool calls (sum) | 0 | 15 | 0 | 15 |
