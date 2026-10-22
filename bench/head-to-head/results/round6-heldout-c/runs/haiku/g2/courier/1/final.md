I wrote `bot.mjs` with `decide(candidate, now)`. All 11 tests pass in `bot.test.mjs`. I ran them on Node 24.13, not Node 22, but the code only uses standard APIs. Nothing is sent and nothing is committed.

Behavior:
- **Transactional** pushes always return `{ send: true, rule: null }`. They skip quiet hours and the cap, and they don't count toward the cap.
- **Marketing** pushes are checked in this order:
  1. **`quiet-hours`**: the customer's local time is inside their window. The window is `[quietStart, quietEnd)` and may wrap past midnight.
  2. **`daily-cap`**: the customer already has 3 allowed marketing pushes on their local calendar day.
  3. Otherwise it sends and counts the push.
- The local day and time come from `Intl` in the customer's time zone, computed from `now`. The server's zone is never used. A test covers an instant that is the same UTC day but a different local day.
- Invalid input throws a `TypeError`: a bad category, a bad IANA zone, a malformed `HH:MM`, a missing `userId`, or an invalid `now`. I chose throwing over silently blocking or sending.
- Old day counters are dropped once per UTC day, so memory stays bounded.

Decisions you should check:
- **Quiet hours do not apply to transactional pushes.** Your spec didn't say. I assumed a courier-arrival or security-code push should still get through at night. If quiet hours should also block transactional pushes, that is a one-line change.
- **If both rules apply, `quiet-hours` is reported** rather than `daily-cap`.
- **`quietStart === quietEnd` means no quiet window.** It does not mean "all day".

Files are in `work/courier-g2-1/`:
- `bot.mjs`
- `bot.test.mjs`. Run with `node --test bot.test.mjs`. It is an extra file you didn't ask for; delete it if you don't want it.
