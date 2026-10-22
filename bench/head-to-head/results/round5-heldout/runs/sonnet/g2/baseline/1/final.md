`bot.mjs` is written and works. It exports `createPushGate()`, whose `attempt(user, now)` returns `{ allowed, reason }`. I checked it with a throw-away script (`/tmp/gate-check.mjs`), which passed. Nothing was sent.

**Rules, checked in this order (first failure wins):**
1. `invalid_now` is returned when `now` isn't a valid Date.
2. `invalid_user_settings` is returned for a missing id, an unknown time zone, a malformed HH:MM, or a `dailyCap` that isn't an integer ≥ 0. The gate fails closed: when it can't tell what the user wants, it sends nothing.
3. `quiet_hours` is returned when the user's local time is in the quiet period. The start is inclusive and the end is exclusive, so 22:00–07:00 blocks 06:59 and allows 07:00. A period that runs past midnight works. If `quietStart` equals `quietEnd`, I treat that as no quiet period.
4. `daily_cap_reached` is returned once the user has had `dailyCap` pushes that local day. A `dailyCap` of 0 blocks everything.

**What "day" and "night" mean:**
- **Local time:** Both use the user's own time zone, with daylight saving handled through `Intl`. The cap is the local calendar day, not UTC midnight and not a rolling 24 hours, so a Tokyo user's count resets at their midnight.
- **What counts:** Only allowed calls count toward the cap. Blocked attempts don't use up the allowance.
- **Per-call settings:** Settings are read from each call, so a changed `dailyCap` or `timeZone` applies immediately. History is stored per user id and trimmed to 3 days.

**What I tested:** Tokyo quiet-hours edges, the cap resetting at local midnight, a New York spring-forward day (2026-03-08), a same-day quiet window, a cap of 0, independence between users and between gates, and bad input.

**Not in your spec:** I did not add a minimum gap between pushes, because you didn't ask for one. If users still get bursts inside the cap, a gap rule would be a small addition. It would need its own reason code.
