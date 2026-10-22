I wrote `bot.mjs` in the work directory. It exports `decide(candidate, now)` and passes 11 checks I ran against it. Nothing is sent and nothing is committed.

**Rules, in the order they are checked:**
1. **Transactional** always returns `{ send: true, rule: null }`. It skips both the quiet window and the cap.
2. **Marketing inside the customer's quiet window** returns `rule: "quiet-hours"`. Windows that run past midnight work, and the start time is inclusive while the end time is exclusive.
3. **Marketing after 3 sends that local day** returns `rule: "daily-cap"`.

Each send that passes is counted per user and per the customer's local calendar date, so the cap resets at their local midnight. A marketing push blocked by quiet hours does not use up a slot.

**Choices you should check:**
- **Quiet hours do not apply to transactional pushes.** I read "a customer waiting for a courier must still hear about it" as covering both rules. If a security code should respect the do-not-disturb window, that is a one-line change.
- **Quiet hours are checked before the cap.** When both would stop a push, the log says `quiet-hours`.
- **Bad input throws instead of returning a decision.** That covers an unknown IANA zone, a malformed `HH:MM`, an unknown category, an empty `userId`, and an invalid `Date`. A bad candidate fails loudly and never reaches the send path.
- **A window whose start equals its end counts as empty.** It does not mean "all day".
- **Counts are kept in memory and keyed by user and local date.** Each user's older days are dropped on their next call, so memory stays small. A restart clears the counts, as you allowed.
- **Concurrent calls cannot double-count.** `decide` is synchronous, so the check and the increment cannot interleave within one Node process. Two processes would each keep their own counts.

**Verification:** I ran `node --check` on the file, which passed. I also ran 11 behaviour checks from `/tmp/bot-check/check.mjs`, outside the repo, and all passed. They cover:
- transactional bypass
- wrap-around window boundaries in Istanbul time
- a blocked push not consuming the cap
- the 3-per-day cap and the 4th being blocked
- local midnight, not UTC midnight
- different zones on the same instant
- a DST fall-back day in New York
- an empty window
- a non-wrapping window
- independent caps per user
- invalid input throwing
