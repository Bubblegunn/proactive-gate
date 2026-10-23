Commit under test: 71fdf2501f8b3dce6d868cfdf5cfbee97a9d9ac2

### All criteria

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| k1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 0.00 [0, 0, 0] (0-0, n=3) |
| k2 (6) | 5.00 [5, 5, 5] (5-5, n=3) | 5.33 [6, 5, 5] (5-6, n=3) | 5.67 [6, 5, 6] (5-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) |
| k3 (6) | 5.33 [4, 6, 6] (4-6, n=3) | 5.00 [6, 6, 3] (3-6, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| k4 (6) | 4.67 [4, 5, 5] (4-5, n=3) | 4.33 [6, 5, 2] (2-6, n=3) | 4.00 [5, 5, 2] (2-5, n=3) | 3.33 [0, 5, 5] (0-5, n=3) |
| k5 (6) | 4.33 [3, 5, 5] (3-5, n=3) | 3.67 [4, 4, 3] (3-4, n=3) | 3.67 [4, 4, 3] (3-4, n=3) | 4.33 [5, 5, 3] (3-5, n=3) |
| total of means (30) | 25.33 | 24.33 | 23.33 | 18.33 |

| measure | baseline | courier-inv | courier | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.014 | 0.015 | 0.013 | 0.014 |
| cost vs baseline | 1.00 | 1.06 | 0.89 | 0.97 |
| mean wall time per run, seconds | 78 | 70 | 68 | 71 |
| mean turns per run | 7.1 | 8.9 | 7.0 | 5.9 |
| mean lines of code written (source files) | 125 | 152 | 126 | 299 |
| mean lines written (all text files) | 125 | 152 | 126 | 299 |
| runs whose solution mentions proactive-gate | 0/15 | 0/15 | 0/15 | 0/15 |
| Skill tool calls (sum) | 0 | 15 | 0 | 15 |
