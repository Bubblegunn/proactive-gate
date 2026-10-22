Commit under test: 5dbfaf3b3c16f99f02af5c30ccf35aab047c2835

### Outcome criteria only (labels.json)

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | courier | courier-inv | knock | knock-inv | ours |
|---|---|---|---|---|---|---|
| g1 (6) | 5.00 [3, 6, 6] (3-6, n=3) | 5.00 [3, 6, 6] (3-6, n=3) | 4.00 [6, 3, 3] (3-6, n=3) | 4.00 [3, 6, 3] (3-6, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 3.00 [3, 3, 3] (3-3, n=3) |
| g2 (6) | 5.33 [6, 4, 6] (4-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| g5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (30) | 28.33 | 29.00 | 28.00 | 28.00 | 27.00 | 27.00 |

| measure | baseline | courier | courier-inv | knock | knock-inv | ours |
|---|---|---|---|---|---|---|
| mean cost USD per run | 0.093 | 0.095 | 0.133 | 0.095 | 0.118 | 0.095 |
| cost vs baseline | 1.00 | 1.02 | 1.43 | 1.02 | 1.26 | 1.02 |
| mean wall time per run, seconds | 40 | 41 | 44 | 40 | 44 | 38 |
| mean turns per run | 4.1 | 4.2 | 7.3 | 4.0 | 7.4 | 5.9 |
| mean lines of code written (source files) | 86 | 82 | 85 | 83 | 93 | 68 |
| mean lines written (all text files) | 86 | 82 | 85 | 83 | 93 | 68 |
| runs whose solution mentions proactive-gate | 0/15 | 0/15 | 0/15 | 0/15 | 0/15 | 0/15 |
| Skill tool calls (sum) | 0 | 0 | 15 | 0 | 15 | 12 |
