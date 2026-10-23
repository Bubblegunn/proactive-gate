# Round 7 development gate (ours x3, SDK path; not part of any score table)

Reference = best other arm's published score (c on Sonnet: no rival run exists, so the reference is the task maximum 6.00).
Pass per task: mean strictly above the reference, or at the ceiling (6.00) together with it. Checkers unchanged.

## Iteration 1 (build `78506d4`)

- round-5 held-out set (seen), haiku: total 29.33 of 30; FAIL; cost 0.15 USD, 5.9 turns per run
  g1 6.00 [6, 6, 6] ref 3.00 ok; g2 5.33 [6, 4, 6] ref 6.00 FAIL; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 6.00 [6, 6, 6] ref 6.00 ok
- round-5 held-out set (seen), sonnet: total 28.00 of 30; FAIL; cost 1.37 USD, 5.3 turns per run
  g1 6.00 [6, 6, 6] ref 5.00 ok; g2 6.00 [6, 6, 6] ref 6.00 ok; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 4.00 [6, 6, 0] ref 6.00 FAIL; g5 6.00 [6, 6, 6] ref 6.00 ok
- round-6 held-out set c (seen), haiku: total 28.33 of 30; FAIL; cost 0.18 USD, 7.2 turns per run
  g1 6.00 [6, 6, 6] ref 5.67 ok; g2 4.67 [4, 4, 6] ref 5.67 FAIL; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 5.67 [6, 5, 6] ref 6.00 FAIL
- round-6 held-out set c (seen), sonnet: total 26.67 of 30; FAIL; cost 1.42 USD, 5.9 turns per run
  g1 4.00 [6, 3, 3] ref 6.00 FAIL; g2 5.00 [5, 5, 5] ref 6.00 FAIL; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 5.67 [6, 5, 6] ref 6.00 FAIL

Iteration 1: FAIL; cell cost 3.12 USD

## Iteration 2 (build `044544c`)

- round-5 held-out set (seen), haiku: total 29.00 of 30; PASS; cost 0.15 USD, 6.3 turns per run
  g1 5.00 [5, 5, 5] ref 3.00 ok; g2 6.00 [6, 6, 6] ref 6.00 ok; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 6.00 [6, 6, 6] ref 6.00 ok
- round-5 held-out set (seen), sonnet: total 29.00 of 30; FAIL; cost 1.51 USD, 5.6 turns per run
  g1 5.00 [5, 5, 5] ref 5.00 FAIL; g2 6.00 [6, 6, 6] ref 6.00 ok; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 6.00 [6, 6, 6] ref 6.00 ok
- round-6 held-out set c (seen), haiku: total 25.67 of 30; FAIL; cost 0.16 USD, 6.6 turns per run
  g1 6.00 [6, 6, 6] ref 5.67 ok; g2 4.67 [4, 5, 5] ref 5.67 FAIL; g3 4.00 [3, 6, 3] ref 6.00 FAIL; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 5.00 [5, 5, 5] ref 6.00 FAIL
- round-6 held-out set c (seen), sonnet: total 28.00 of 30; FAIL; cost 1.40 USD, 5.9 turns per run
  g1 6.00 [6, 6, 6] ref 6.00 ok; g2 4.00 [3, 5, 4] ref 6.00 FAIL; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 6.00 [6, 6, 6] ref 6.00 ok

Iteration 2: FAIL; cell cost 3.22 USD

## Iteration 3 (build `6bdfc6c`)

- round-5 held-out set (seen), haiku: total 28.67 of 30; FAIL; cost 0.16 USD, 6.0 turns per run
  g1 6.00 [6, 6, 6] ref 3.00 ok; g2 6.00 [6, 6, 6] ref 6.00 ok; g3 4.67 [6, 2, 6] ref 6.00 FAIL; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 6.00 [6, 6, 6] ref 6.00 ok
- round-5 held-out set (seen), sonnet: total 30.00 of 30; PASS; cost 1.39 USD, 5.2 turns per run
  g1 6.00 [6, 6, 6] ref 5.00 ok; g2 6.00 [6, 6, 6] ref 6.00 ok; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 6.00 [6, 6, 6] ref 6.00 ok
- round-6 held-out set c (seen), haiku: total 26.33 of 30; FAIL; cost 0.17 USD, 7.1 turns per run
  g1 6.00 [6, 6, 6] ref 5.67 ok; g2 3.00 [0, 4, 5] ref 5.67 FAIL; g3 6.00 [6, 6, 6] ref 6.00 ok; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 5.33 [5, 6, 5] ref 6.00 FAIL
- round-6 held-out set c (seen), sonnet: total 27.00 of 30; FAIL; cost 1.54 USD, 6.3 turns per run
  g1 6.00 [6, 6, 6] ref 6.00 ok; g2 5.00 [6, 3, 6] ref 6.00 FAIL; g3 4.67 [6, 2, 6] ref 6.00 FAIL; g4 6.00 [6, 6, 6] ref 6.00 ok; g5 5.33 [6, 5, 5] ref 6.00 FAIL

Iteration 3: FAIL; cell cost 3.26 USD

Development gate cell cost, all iterations: 9.60 USD
