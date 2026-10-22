I wrote `bot.mjs`, which exports `createPushGate()`. I tested it with a script at `/tmp/gate-test.mjs`, and every check passes. It ran under Node 24 here, not Node 22, but the code uses nothing beyond `Intl` and standard JavaScript. Nothing was sent.

**What it does:** `attempt(user, now)` runs the checks in this order and stops at the first one that fails. It returns `{ allowed: true, reason: null }` and records the push only when all pass.

1. **Invalid input** is blocked, so bad data never wakes anyone. Each case has its own code: `invalid_time`, `invalid_user`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`.
2. **Quiet hours** gives `quiet_hours`. The window is checked against the user's local clock, in the user's `timeZone`.
   - The start is inclusive and the end is exclusive.
   - It handles windows that run past midnight, such as 22:00 to 07:00.
3. **Daily cap** gives `daily_cap_reached`. A "day" is the user's local calendar day, midnight to midnight, not a rolling 24 hours. The count uses local-day boundaries, so it follows daylight saving changes.

**Choices I made that you didn't specify:**
- Blocked attempts don't count toward the cap. Only allowed ones do.
- If `quietStart` equals `quietEnd`, I treat that as no quiet period.
- A `dailyCap` of 0 blocks every push.
- If both rules would block, `quiet_hours` is the reason returned.
- Time zone, quiet hours and cap are all read from the `user` passed in each call, so changed settings take effect immediately.
- History is per user ID and separate for each gate. It holds only about 72 hours of send times per user, so memory stays bounded.

**What the tests cover:** Tokyo quiet-hour edges, the cap resetting at local midnight (a New York user across a daylight saving date), users and gates not affecting each other, settings changing between calls, a quiet window that doesn't cross midnight, a cap of 0, and each invalid-input code.

I didn't add a minimum gap between pushes, since you only specified the cap. Three pushes within a minute would all be allowed. If bursts are part of the complaint, a gap rule is a small addition.
