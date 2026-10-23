# Round 8 development gate, iteration 1 (build 71fdf25)

Protocol: `docs/DEV-GATE-round8.md` (frozen in a91a5a5, before the first run). Path: subscription wrapper, parallelism 3, probe passed on every set. Decision rules P1 to P4.
Sets: k (ours, baseline, courier, courier-inv), r5 and c (ours only). Transcripts are not committed (SHA-256 sums are, `*/SHA256SUMS-runs.txt`); `results.json` paths are redacted to /REPO.

| model | set | ours | best other | verdict |
|---|---|---|---|---|
| Sonnet | k | 28.33 | courier-inv 26.33 (baseline 24.33, courier 25.67) | P1 pass: ours minus best other +2.00, 95% interval [1.00, 3.00]; P2 fail: k3 ours 5.00 against 6.00 (HELP keyword not answered in 3 of 3 runs); P4 pass: cost 0.66 of baseline, turns 5.4 against 5.7 |
| Sonnet | r5 | 30.00 | reference 29.00 | P3 pass |
| Sonnet | c | 30.00 | reference 28.00 | P3 pass |
| Haiku | k | 18.33 | baseline 25.33 | P1 fail: -7.00, interval [-10.67, -4.33]; k1 0.00 in 3 of 3 runs (the skill fired, the agent blocked every text for "no consent on record" because the data carried no consent field); P2 fail; P4 pass (0.97 of baseline) |
| Haiku | r5 | 29.00 | 27.00 | P3 pass |
| Haiku | c | 27.33 | 28.00 | P3 fail (g1 run without a skill call, g2 cap and DST, g5 stop-word false positives in 2 runs without a skill call) |

Gate: not passed on Sonnet (P2) or on Haiku (P1, P2, P3). Failure classes found in the ours cells (all general):
1. A promotion text blocked for "no consent on record" when the interface carries no consent field (Haiku k1, 3 of 3). Rule 2(c) was written for data that carries a consent field.
2. HELP/INFO keyword gets no reply (k3 criterion 5, 6 of 6 ours cells on both models). Neither the kit nor rule 7 mentions it.
3. A security alert held by quiet hours when the request does not say it must still reach the person (Haiku k4, 2 of 3).
4. A retry of a message id reports the silent in-app item only once (k4 criterion 6, 2 of 3 on each model): the agent applied "spend nothing twice" to the inbox item.
Not product defects: Haiku cells where the skill was not called (c g1 run 2, c g5 runs 2 and 3) behave like the baseline.
