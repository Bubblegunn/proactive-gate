`bot.mjs` is written at `work/baseline-g2-1/bot.mjs`. All 13 tests pass. The tests are in `/tmp/bot-test/bot.test.mjs`, outside the repo. Nothing is sent, and I did not commit.

**Behaviour**
- **Transactional** pushes always return `{ send: true, rule: null }`. They skip the quiet window and the cap, and they don't count toward the cap.
- **Marketing** pushes are checked in this order:
  1. Quiet window, using the customer's local clock. Returns `rule: "quiet-hours"`.
  2. Daily cap of 3 per customer-local calendar day. Returns `rule: "daily-cap"`.
  3. Otherwise returns `{ send: true, rule: null }` and counts the push.
- Counts are kept per `userId` and local date. A late call with an earlier local date does not reset today's count. Old days are pruned once per new date, so memory stays bounded.
- Blocked pushes are never counted.

**Choices I made that you should confirm**
- **Quiet hours apply to marketing only.** You did not say whether quiet hours should also hold transactional pushes. I assumed a courier or security code should get through at night. If not, I'll change the transactional branch.
- **Quiet window bounds:** start is inclusive and end is exclusive. So 22:00–07:30 blocks 22:00 and 07:29, and allows 07:30. A window where start equals end means no quiet window.
- **Invalid input throws** a `TypeError` (bad category, bad `HH:MM`, invalid `Date`) or a `RangeError` (unknown IANA zone). Transactional pushes skip validation of the quiet and timezone fields, since they are not used on that path. A throw inside a job will stop that job, so the callers need to handle it.
- **No timezone fallback.** The server clock is never used. All local-time logic goes through `Intl` with the customer's zone.

**Tests** cover:
- transactional bypass and no counting
- the 3-per-day cap
- local-day rollover in Tokyo and New York, not UTC
- midnight-crossing and same-day quiet windows, including edges
- DST on the New York fall-back day
- quiet-hours blocks not counting toward the cap
- ordering when both rules would apply
- invalid-input errors

One test failure during the run was my own mistake: the Tokyo test window overlapped quiet hours. I fixed the test, not the module.
