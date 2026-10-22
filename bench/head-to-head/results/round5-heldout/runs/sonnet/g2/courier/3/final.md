`bot.mjs` is written and exports `createPushGate()`. It passed my check script (`/tmp/gate-check.mjs`), which exercises quiet hours, the daily cap, DST and bad input. Nothing was sent.

**Rules**, checked in this order:
1. **Quiet hours** (`quiet_hours`): uses the user's own clock time, from `timeZone` and the HH:MM settings. The start is inclusive and the end is exclusive. A period that runs past midnight works, such as 22:00 to 07:00. If start equals end, I treat that as no quiet period.
2. **Daily cap** (`daily_cap_reached`): "per day" means the user's local calendar day, so the count resets at their midnight, not at UTC midnight. A `dailyCap` of 0 blocks everything.

**Invalid input** returns `invalid_user_settings` (bad zone, bad HH:MM, bad cap, missing id) or `invalid_time` (bad `Date`). The gate fails closed: a push is blocked when the settings can't be read.

**History:**
- Only allowed calls are recorded, so blocked attempts never use up the cap. Quiet-hours checks run first for the same reason.
- Settings come from the current call. Past pushes are re-assigned to local days using the zone passed in that call, so a user who changes zone is counted by the day they are living now.
- History is kept in memory and pruned after 72 hours.

**Decision for you:** I did not add a minimum gap between pushes. The Apple and Google guidance on avoiding bursts would support one, but it would be an extra rule you didn't ask for. It would also change behaviour for callers that send several pushes close together. If you want it, I'd add it as its own code, such as `too_soon`.
