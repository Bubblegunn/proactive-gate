Commit under test: 71fdf2501f8b3dce6d868cfdf5cfbee97a9d9ac2

### All criteria

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| k1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| k2 (6) | 5.33 [6, 5, 5] (5-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.33 [6, 5, 5] (5-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| k3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| k4 (6) | 4.00 [2, 5, 5] (2-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.33 [5, 5, 6] (5-6, n=3) |
| k5 (6) | 3.00 [3, 3, 3] (3-3, n=3) | 4.33 [3, 5, 5] (3-5, n=3) | 3.33 [4, 3, 3] (3-4, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 24.33 | 26.33 | 25.67 | 28.33 |

| measure | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.176 | 0.201 | 0.168 | 0.117 |
| cost vs baseline | 1.00 | 1.14 | 0.96 | 0.66 |
| mean wall time per run, seconds | 126 | 116 | 111 | 40 |
| mean turns per run | 5.7 | 7.7 | 6.1 | 5.4 |
| mean lines of code written (source files) | 138 | 120 | 134 | 336 |
| mean lines written (all text files) | 138 | 120 | 134 | 336 |
| runs whose solution mentions proactive-gate | 0/15 | 0/15 | 0/15 | 0/15 |
| Skill tool calls (sum) | 0 | 15 | 0 | 15 |
