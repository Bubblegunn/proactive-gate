Commit under test: 30fdfaed2afa99c1ee1fce45dfbf0fe02ed90e84

### All criteria

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| z1 (6) | 5.67 [6, 6, 5] (5-6, n=3) | 4.00 [6, 0, 6] (0-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 4.67 [5, 5, 4] (4-5, n=3) |
| z2 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 4.67 [5, 4, 5] (4-5, n=3) | 4.67 [5, 5, 4] (4-5, n=3) | 2.67 [1, 4, 3] (1-4, n=3) |
| z3 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 5.00 [5, 6, 4] (4-6, n=3) | 3.67 [5, 3, 3] (3-5, n=3) | 2.00 [1, 1, 4] (1-4, n=3) |
| z4 (6) | 3.33 [4, 2, 4] (2-4, n=3) | 2.67 [2, 2, 4] (2-4, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 4.33 [4, 5, 4] (4-5, n=3) |
| z5 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) |
| z6 (6) | 4.33 [4, 4, 5] (4-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.33 [4, 4, 5] (4-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| total of means (36) | 25.33 | 24.33 | 24.33 | 22.67 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.020 | 0.020 | 0.019 | 0.025 |
| cost vs baseline | 1.00 | 1.00 | 0.93 | 1.27 |
| mean wall time per run, seconds | 104 | 96 | 98 | 108 |
| mean turns per run | 7.5 | 9.4 | 7.1 | 14.1 |
| mean lines of code written (source files) | 188 | 176 | 205 | 127 |
| mean lines written (all text files) | 188 | 176 | 205 | 128 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 15/18 |
| Skill tool calls (sum) | 0 | 18 | 0 | 16 |
