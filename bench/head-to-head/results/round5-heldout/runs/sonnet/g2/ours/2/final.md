`bot.mjs` is written and passes my self-check script. It exports `createPushGate()` with `attempt(user, now)`, and each gate keeps its own history in memory. The script covers allowed calls, quiet-hour edges, the cap, a daylight-saving zone and bad input. I ran it on Node 24, not 22. Nothing is sent.

The skill's default was to write the gate inline, so I did that. I followed your spec where it differs from the skill's persistence and plain-sentence rules. State stays in memory, and refusals use snake_case codes.

**Rules, checked in this order**
- **Invalid input is held, not guessed:**
  - `invalid_time`: `now` is not a valid Date.
  - `invalid_user`: `user.id` is missing or empty.
  - `invalid_time_zone`: the zone is missing or unknown.
  - `invalid_quiet_hours`: `quietStart` or `quietEnd` is not `HH:MM`.
  - `invalid_daily_cap`: `dailyCap` is not an integer of 0 or more.
- **`quiet_hours`:** the check uses the user's own local time in `timeZone`. The window includes the start minute and excludes the end minute, and it wraps past midnight when start is later than end. If start equals end, I treat the window as empty and nothing is quiet.
- **`daily_cap_reached`:** "day" is the user's own local calendar day, not the UTC day. Only calls that returned `allowed: true` count, so refused calls cost nothing. A cap of 0 blocks every push.

Each call uses the settings passed in that call. The gate stores send times and counts them against the local day, so a change of zone or cap takes effect on the next call. It drops history older than 3 days.

**Choices for you to confirm**
- **No minimum spacing:** I did not add a gap between pushes, such as 2 hours. Three pushes in a row still pass if the cap is 3. Say so if you want a spacing rule as well.
- **Quiet hours off by default:** an empty window (start equals end) disables quiet hours. A user who means "always quiet" would get pushes.
