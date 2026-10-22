`bot.mjs` is written and passes 13 test groups. No push was sent and nothing calls Courier.

**File:** `work/courier-inv-g2-1/bot.mjs`, exports `decide(candidate, now)`.

**Behavior**
- **Quiet hours** (marketing only): checked in the customer's own time zone. The start is inclusive and the end exclusive, so `07:29` is blocked and `07:30` is allowed. Windows that cross midnight work. If `quietStart` equals `quietEnd`, there is no quiet window. Blocked returns `{ send: false, rule: "quiet-hours" }`.
- **Daily cap** (marketing only): at most 3 sends per `userId` per customer-local calendar day. The 4th returns `{ send: false, rule: "daily-cap" }`. Quiet-hours blocks don't count toward the cap.
- **Transactional**: always returns `{ send: true, rule: null }`. It skips both rules and is not counted.
- **Invalid input** (bad `HH:MM`, unknown time zone, unknown category, invalid `now`, empty `userId`) throws instead of returning a rule. Each throw names the bad field.
- **Memory**: counts are keyed by user and local date. Entries older than two UTC days are pruned, so memory stays bounded.

**Decisions for you to confirm**
1. **Transactional during quiet hours.** I let transactional pushes through quiet hours, so a courier or OTP at 23:00 still gets sent. The brief could also mean the quiet window should block everything. If so, change the `category === "transactional"` early return.
2. **Rule order.** When both rules would stop a marketing push, `quiet-hours` is reported first.

**Verification**
- Tests are in `/tmp/bot-test/test.mjs`, outside the work directory. They cover the cap resetting at local midnight, the customer's time zone (not UTC) deciding the day, midnight-crossing and non-crossing windows, the exact boundaries, quiet blocks not consuming the cap, transactional bypass, per-user separation, pruning, and invalid input.
- Local runtime is Node v24.13.0. I could not run Node 22 here. The module uses only `Intl.DateTimeFormat` with `hourCycle`, `formatToParts`, `Map`, and `??`, which Node 22 supports.

The courier skill covers Courier's native delivery windows and frequency caps. I did not use them, because you asked for an in-process gate that decides before the caller hands off to the push provider.
