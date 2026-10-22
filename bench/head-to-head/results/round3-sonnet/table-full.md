Commit under test: 30fdfaed2afa99c1ee1fce45dfbf0fe02ed90e84

### All criteria

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| z1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| z2 (6) | 4.00 [5, 3, 4] (3-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.67 [4, 4, 6] (4-6, n=3) | 4.00 [4, 4, 4] (4-4, n=3) |
| z3 (6) | 3.00 [4, 5, 0] (0-5, n=3) | 3.00 [0, 4, 5] (0-5, n=3) | 4.33 [4, 6, 3] (3-6, n=3) | 3.00 [3, 3, 3] (3-3, n=3) |
| z4 (6) | 2.00 [2, 2, 2] (2-2, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 2.67 [4, 2, 2] (2-4, n=3) | 0.00 [0, 0, 0] (0-0, n=3) |
| z5 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 5.33 [5, 5, 6] (5-6, n=3) |
| z6 (6) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| total of means (36) | 24.00 | 23.00 | 25.67 | 22.33 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.140 | 0.188 | 0.140 | 0.272 |
| cost vs baseline | 1.00 | 1.34 | 1.00 | 1.94 |
| mean wall time per run, seconds | 146 | 332 | 90 | 238 |
| mean turns per run | 3.7 | 4.8 | 3.8 | 11.8 |
| mean lines of code written (source files) | 161 | 149 | 160 | 249 |
| mean lines written (all text files) | 161 | 149 | 160 | 257 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 18/18 |
| Skill tool calls (sum) | 0 | 18 | 0 | 18 |
