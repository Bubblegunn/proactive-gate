`bot.mjs` is written and exports `createPushGate()`. I checked it with a throwaway script at `/tmp/t.mjs` that passed. It sends nothing. I only skimmed the Courier skill's throttling and push docs. The gate doesn't call Courier, because quiet hours and caps are enforced in your own code before the send.

**What `attempt(user, now)` does, in this order:**
1. **Bad input:** it denies with `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours` or `invalid_daily_cap`. I chose to block when the settings can't be trusted, so a bad setting never pushes at night.
2. **`quiet_hours`:** it uses the user's local time in their `timeZone`. The start is included and the end is excluded, so 22:00–07:00 blocks 22:00 through 06:59. It handles periods that run past midnight. If `quietStart` equals `quietEnd`, I treat that as no quiet hours.
3. **`daily_cap_reached`:** "per day" is the user's local calendar day, not UTC. Only pushes that were allowed count, so quiet-hour denials don't use up the cap. A `dailyCap` of 0 blocks everything.
4. **Allowed:** it returns `{ allowed: true, reason: null }` and records the push.

Settings are read from each call, and each gate keeps its own history in memory. Records older than 48 hours are dropped on later calls for that user.

**What the test covered:** the quiet-period edges, the cap, and a Los Angeles user whose local day continues past UTC midnight. It also covered the new-day reset, a daytime quiet window, `dailyCap: 0`, a bad time zone, and that users and gates are independent.

**One thing you may want to change:** the gate has no minimum gap between pushes. A user with `dailyCap: 3` could get three pushes in one minute. Apple and Google both advise against bursts like that. I left it out because you didn't specify a gap, and it would change which calls are allowed. A gap of 60–120 minutes would be a small addition with its own reason code.
