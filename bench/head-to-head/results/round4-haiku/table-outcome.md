Commit under test: 53700e77e3f0bbc7706e8282cce55d83e89fd176

### Outcome criteria only (labels.json)

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | courier-inv | courier | ours |
|---|---|---|---|
| z1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 5.33 [6, 5, 5] (5-6, n=3) |
| z2 (6) | 4.33 [4, 4, 5] (4-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 1.00 [1, 1, 1] (1-1, n=3) |
| z3 (6) | 2.67 [0, 5, 3] (0-5, n=3) | 4.00 [5, 4, 3] (3-5, n=3) | 1.33 [3, 1, 0] (0-3, n=3) |
| z4 (6) | 2.00 [2, 2, 2] (2-2, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 4.00 [4, 4, 4] (4-4, n=3) |
| z5 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) |
| z6 (6) | 4.33 [4, 5, 4] (4-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.33 [4, 4, 5] (4-5, n=3) |
| total of means (36) | 23.33 | 24.67 | 20.00 |

| measure | courier-inv | courier | ours |
|---|---|---|---|
| mean cost USD per run | 0.160 | 0.212 | 0.346 |
| cost vs baseline | n/a | n/a | n/a |
| mean wall time per run, seconds | 244 | 102 | 128 |
| mean turns per run | 9.2 | 7.9 | 18.1 |
| mean lines of code written (source files) | 180 | 228 | 118 |
| mean lines written (all text files) | 180 | 228 | 118 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 15/18 |
| Skill tool calls (sum) | 11 | 0 | 15 |
