# Round 8 development gate, iteration 2 (build 5fe287e)

Rulings R8-10 to R8-14 (HEAD-TO-HEAD.md, commit 46d0560) were frozen before the code change. Ours only, 3 runs per task; the rival and baseline cells on set k are those of iteration 1 (same path, same pinned code; reuse allowed only inside this gate, per `docs/DEV-GATE-round8.md`).

| model | set | ours | reference | verdict |
|---|---|---|---|---|
| Sonnet | k | 28.33 | best other courier-inv 26.33 (baseline 24.33, courier 25.67) | P1 pass: +2.00, 95% interval [1.00, 3.00]; P2 pass (one task, k2, 0.33 behind, inside the 0.34 allowance); P4 pass: cost 0.120 USD per run against the baseline's 0.176, turns 5.9 against 5.7 |
| Sonnet | r5 | 30.00 | 29.00 | P3 pass |
| Sonnet | c | 30.00 | 28.00 | P3 pass |
| Haiku | k | 28.33 | best other baseline 25.33 | P1 pass: +3.00, interval [1.00, 4.33]; P2 pass; P4 FAIL by 2.3 percent: cost 0.01468 against 0.01434 USD per run (turns 7.0 against 7.1) |
| Haiku | r5 | 29.00 | 27.00 | P3 pass |
| Haiku | c | 27.00 | 28.00 | P3 FAIL: g2 cap and DST (2 runs), g3 opt-in block (1 run), g1 and g5 runs where the skill was not called |

Gate under the frozen text of `docs/DEV-GATE-round8.md` (clear lead on both models): Sonnet passes P1 to P4. Haiku misses P3 on set c (1.00) and P4 (2.3 percent). The owner decided on 2026-10-23, after the gate was frozen and after iteration 1, that the launch claim rests on Sonnet and that Haiku is reported descriptively; this is recorded as a departure from the frozen text, not as a pass on Haiku. No third iteration was run (owner rule: do not iterate to close the last points).

Departures and invalid cells:
- The subscription session limit was reached during `c-haiku`: three cells (ours g3 run 3, g4 run 3, g5 run 3) returned HTTP 429 `usage_limit_reached` (exit code 1, cost 0 to 0.007 USD) and the runner of that time did not stop. They were never graded: removed, kept for the record in `_invalid-limit-cells/` (not committed), and run again from scratch after the limit reset with the same commit. The runner now stops on HTTP 429, 401 and 403 (commit after 5fe287e).
- Iteration 1 and 2 `results.json` paths are redacted to /REPO and /HOME.
