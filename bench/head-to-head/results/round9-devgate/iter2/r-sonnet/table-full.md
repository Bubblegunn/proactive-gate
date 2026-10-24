Commit under test: e9ebdca9dadca16df50c2e6cef70f0f1d8afa90c

### All criteria

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| r1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| r2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| r3 (6) | 5.33 [6, 5, 5] (5-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.33 [5, 5, 6] (5-6, n=3) |
| r4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| r5 (6) | 5.33 [5, 5, 6] (5-6, n=3) | 5.33 [5, 5, 6] (5-6, n=3) | 5.33 [5, 5, 6] (5-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 28.67 | 28.33 | 28.33 | 28.33 |

| measure | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.106 | 0.149 | 0.106 | 0.102 |
| cost vs baseline | 1.00 | 1.40 | 1.00 | 0.96 |
| mean wall time per run, seconds | 42 | 42 | 41 | 33 |
| mean turns per run | 4.3 | 6.1 | 4.1 | 4.3 |
| mean lines of code written (source files) | 78 | 88 | 97 | 174 |
| mean lines written (all text files) | 78 | 88 | 97 | 174 |
| runs whose solution mentions proactive-gate | 0/15 | 0/15 | 0/15 | 1/15 |
| Skill tool calls (sum) | 0 | 15 | 0 | 15 |
