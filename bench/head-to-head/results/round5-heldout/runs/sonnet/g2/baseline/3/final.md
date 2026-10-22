`bot.mjs` is written and exports `createPushGate()`. My check script (`/tmp/gate-check.mjs`, outside the repo) passes. It covers quiet hours across midnight, the daily cap resetting at local midnight, a DST change in Berlin, and bad input. Nothing was sent.

**How it decides**
- **Quiet hours:** it uses the user's local clock in their `timeZone`. A window like 22:00–07:00 can run past midnight. The start time is inside the window and the end time is outside it, so 07:00 is allowed.
- **Daily cap:** "per day" means the user's local calendar day, not a rolling 24 hours and not UTC. The cap resets at the user's local midnight. Each gate keeps a user's push times for 3 days and works out the local day from the zone and settings passed in that call.
- **Order of checks:** quiet hours come first, then the cap. A blocked call doesn't count toward the cap. An allowed call is recorded as sent.

**Reason codes**
- `quiet_hours`
- `daily_cap_reached`
- `invalid_user_settings`: a bad time zone, a bad `HH:MM` string, or a `dailyCap` that isn't a non-negative integer.
- `invalid_input`: a missing user id or an invalid `Date`.

**Choices to confirm**
- Bad input blocks the push and returns a code, instead of throwing. That way a settings bug can't crash the agent or send a push at the wrong hour.
- If `quietStart` equals `quietEnd`, I treat it as no quiet hours.
- `dailyCap: 0` blocks every push.
- I did not add a minimum gap between pushes, because you only specified quiet hours and a daily cap. Say if you want one. A burst of 3 pushes in a minute is currently allowed.
