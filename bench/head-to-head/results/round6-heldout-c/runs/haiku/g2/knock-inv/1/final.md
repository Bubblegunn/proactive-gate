`bot.mjs` is written and all 12 tests pass. Nothing was sent.

**File:** `work/knock-inv-g2-1/bot.mjs`, an ES module exporting `decide(candidate, now)`. I ran the tests from `/tmp/bot-test/test.mjs`, outside the repo, so no test files were added.

**How it decides**
- **Transactional** pushes always send. They skip quiet hours and the cap, so a courier or security code is never blocked.
- **Marketing** pushes are checked in this order, and the first failing rule is returned as `rule`:
  1. `quiet-hours`: the customer's own DND window, in their IANA timezone. Windows past midnight work, and the start is inclusive and the end exclusive.
  2. `daily-cap`: at most 3 sent per customer-local calendar day.
- The day is computed in the customer's timezone, so a customer in Auckland gets a new day on their local midnight, not UTC midnight.
- Only sends are counted. A push blocked by quiet hours does not use up the day's cap.

**Choices I made that you may want to change**
- Transactional pushes bypass quiet hours as well as the cap. The brief only said couriers must get through, so this is my reading. The knock skill's rules put quiet hours ahead of frequency caps and treat transactional messages with less restriction, which supports it.
- If `quietStart === quietEnd`, there is no quiet window. The other reading, "all day", is not implemented.
- Bad input throws a `TypeError`: unknown category, invalid timezone, malformed `HH:MM`, invalid `now`, or empty `userId`. The jobs must handle the exception. The alternative would be a silent `send: false`, which would hide bugs.
- A user's count resets when the customer-local day changes. If `now` arrives out of order (earlier than the stored day), the counter resets to that day. That case is not handled specially.
