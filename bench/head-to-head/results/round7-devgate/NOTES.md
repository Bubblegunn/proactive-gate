# Round 7: scoped result and departures

Scoped result: on the development gate of round 7 (ours x3, Claude Agent SDK path, 2026-10-23, Haiku `claude-haiku-5-5` and Sonnet `claude-sonnet-5-5`, on the seen round-5 held-out set and the seen held-out set c, 5 tasks each, 6 outcome
criteria per task) the gate FAILED in all three allowed iterations (builds `78506d4`, `044544c`, `6bdfc6c`; best single set results: Sonnet round-5 set 30.00 of 30 in iteration 3, Haiku round-5 set 29.33 in iteration 1);
held-out d was therefore not written, the new-held-out and public measurements were not run, F9 and F6 were not run, and no claim of "first" or "best" is made. The gate is not a score table.

Departures and facts (all of them):
- The three iterations, their rulings and costs are frozen in `docs/HEAD-TO-HEAD.md`, section "Round 7" and its two addenda, each committed before the code change and run it governs (`231c4cf`, `7994a27`, `c3a119a`).
- Checker nondeterminism (c g2 criterion 4): the unchanged checker returns 4, 5, 5, 4, 5, 4 of 6 over six runs on one fixed, correct Sonnet cell (`ours-g2-2` of iteration 2): `checkers/lib.mjs` loads a module with `?v=Date.now()`, so two loads in the
  same millisecond share state. This lowers c g2 scores of every arm by chance; it is reported, not corrected (criteria and checkers are frozen). The frozen text of the iteration-2 addendum says criterion 4 failed in 5 of 6 cells in both iterations;
  the correct counts, from the grades, are 4 of 6 in iteration 1 and 6 of 6 in iteration 2.
- Size cap: the frozen cap for the skill was 7663 bytes; the iteration-3 build is 7668 bytes (5 bytes over). Not fixed because the build was measured as committed.
- Review: the iteration-3 change (one clause) had no separate Sonnet review; the two earlier changes did (5 and 4 findings, applied).
- The legal-window default added in iteration 2 (rule 6) coincides with new blocks in the cells: c g3 Sonnet run 2 ("Marketing mail is only sent between ..."), c g5 Sonnet runs 2 and 3 ("legal-hours"), and the round-5 g1 regression in iteration 2.
  The report recommends removing that sentence (an unmeasured change), pending the owner's decision.
- Cells include `skillCalls` and `turns`; the traces (`runs/*.jsonl`, ~60 MB with `_setup`) are not committed (size); `results.json` per set holds the per-cell outcome, per-criterion pass/why, cost, turns and time, with home paths replaced by `/HOME/`.
- Run path: Agent SDK shim (`~/claude-kredi-runs/sdk-shim/claude`), CLI 2.1.308, key file name `anthropic_key_2` (the key itself is never written), `apiKeySource` ANTHROPIC_API_KEY; no 429, authentication error or credit-guard refusal occurred.
- Tasks: `../round5-heldout/tasks` (writer: round-5 fresh Sonnet agent) and `../round6-heldout-c/tasks` (writer: fresh Sonnet agent shown only the README user sentence and the task format; see `WRITER.md` there).
