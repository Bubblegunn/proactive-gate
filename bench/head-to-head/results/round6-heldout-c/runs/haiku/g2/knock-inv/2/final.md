`bot.mjs` is written at `work/knock-inv-g2-2/bot.mjs`. It exports `decide(candidate, now)` and sends nothing. My check script passed, run from a scratch directory outside the project, which I then deleted.

**Rules, in order (first match sets `rule`):**
1. `quiet-hours`: marketing only. Window is the customer's local time, start inclusive, end exclusive. Windows that cross midnight work. `start === end` means no window.
2. `daily-cap`: marketing only. Max 3 sent per customer per customer-local calendar day. The count is kept per user, and it resets when the local date changes.

Transactional pushes always return `{ send: true, rule: null }` and are not counted against the cap.

**Choices I made that you should check:**
- **Quiet hours apply to marketing only.** Your spec only says the courier push must get through the cap. I read the same intent as covering the do-not-disturb window too. If a customer's DND should also hold back courier and security pushes, this is a one-line change.
- **Blocked pushes are not counted.** Only pushes that return `send: true` use up the daily cap.
- **Bad input throws** (invalid IANA zone, malformed `HH:MM`, unknown category, invalid `Date`). It does not return `send: false`, so a bad caller shows up as an error instead of being silently blocked.

**Verified by the check script:**
- The cap blocks the 4th marketing push and transactional pushes still go through.
- The window wraps midnight, and `07:30` is allowed while `07:29` is blocked.
- A quiet-hours block does not use up cap.
- The day boundary follows the customer's local midnight, not UTC.
- A DST transition (New York, 2026-11-01) is handled.
- Invalid inputs throw.

The module has no dependencies. It uses only `Intl` and `Map`, so it should run on Node 22. I ran it on Node 24 only.
