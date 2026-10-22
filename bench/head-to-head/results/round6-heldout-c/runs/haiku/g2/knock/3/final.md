Wrote `bot.mjs` and a test file, `bot.test.mjs`. All 13 tests pass with `node --test`. Nothing is sent.

**Rule order:** a marketing push is checked against quiet hours first, then the daily cap. The first rule that stops it is the one reported. Transactional pushes skip both, so a courier or security code always gets through.

**Behavior:**
- **Quiet hours:** read as the customer's local time, in their IANA zone. The window may cross midnight. The start is inclusive and the end is exclusive.
- **Daily cap:** 3 marketing sends per customer-local calendar day. Each count is keyed by the local date in the candidate's zone. A blocked push does not use up a slot.
- **Transactional:** does not count toward the marketing cap.
- **State:** `Map<userId, Map<localDate, count>>`. Old days are pruned per user on each send.

**Choices I made that you should check:**
1. **Quiet hours apply to marketing only.** Your text says a waiting customer must still hear about the courier, so I let transactional through quiet hours too. If your product wants DND to block transactional pushes as well, this is a one-line change.
2. **`quietStart === quietEnd` means no quiet window.** The brief did not cover this case. Some teams would read it as all day.
3. **Malformed input throws.** This covers an unknown category, a bad `HH:MM`, a non-Date `now`, and an unknown timezone. The module throws `TypeError` or `RangeError` instead of returning a rule, so a caller bug surfaces rather than silently blocking pushes. The jobs need a try/catch if they should not crash on bad data.
4. **Memory growth:** a user who never returns keeps one small entry until restart. That is fine for a process that restarts, but it grows with the user count. Say if you need a periodic sweep.

Tests cover: midnight-crossing quiet window, boundary times, a non-crossing window, the server-clock versus customer-clock case, the cap and its reset at local midnight, a per-zone day boundary, transactional excluded from the cap, blocked pushes not consuming the cap, rule precedence, and input rejection. The tests run on Node 24 here. The code uses only APIs present in Node 22, but I did not run it on Node 22.
