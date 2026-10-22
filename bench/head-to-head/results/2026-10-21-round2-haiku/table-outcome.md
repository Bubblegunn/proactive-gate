### Outcome criteria only (labels.json)

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| y1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.33 [5, 6, 5] (5-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 5.00 [4, 5, 6] (4-6, n=3) |
| y2 (6) | 5.33 [5, 6, 5] (5-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 4.67 [5, 5, 4] (4-5, n=3) |
| y3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y6 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (36) | 35.33 | 34.33 | 34.67 | 33.67 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.303 | 0.259 | 0.302 | 0.362 |
| mean wall time per run, seconds | 92 | 155 | 89 | 107 |
| mean turns per run | 9.2 | 9.8 | 9.1 | 14.2 |
| mean lines of code written (source files) | 177 | 168 | 176 | 157 |
| mean lines written (all text files) | 178 | 168 | 176 | 157 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 8/18 |
| Skill tool calls (sum) | 0 | 13 | 0 | 18 |
