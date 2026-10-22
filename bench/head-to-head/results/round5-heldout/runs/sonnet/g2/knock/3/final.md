`bot.mjs` is written and exports `createPushGate()`. My check script passed ("all ok"). It exercises the real function and sends nothing.

**What the gate does**
- **Night:** it uses the user's own clock in their `timeZone`, so DST changes are handled. The quiet window includes `quietStart` and excludes `quietEnd`, so 07:00 is allowed. It handles windows that run past midnight. If `quietStart` equals `quietEnd`, I treat that as no quiet period.
- **Day:** the cap counts per local calendar day in the user's zone, not a rolling 24 hours and not UTC. A user at 23:00 and again at 02:30 gets two different days.
- **Counting:** only allowed attempts count toward the cap. Blocked attempts don't.
- **Order of checks:** quiet hours come before the cap. A `dailyCap` of 0 blocks everything.
- **Settings:** it reads `dailyCap` and the quiet hours from each call, so a user who changes settings is handled on the next attempt.
- **History:** each gate keeps its own history, a few local days per user, and old days are dropped.

**Reason codes**
- Normal blocks: `quiet_hours` and `daily_cap_reached`.
- Bad input is refused rather than sent: `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`, `invalid_user` and `invalid_time`.
- Allowed attempts return `reason: null`.

I didn't add a minimum gap between pushes, because you didn't ask for one. Three pushes within a minute would still pass. Say if you want one.

The check script is `/tmp/pushgate-check.mjs`. It covers the Tokyo boundaries, the LA day versus UTC day, the DST end, windows with and without midnight wrap, per-call settings, independent gates and the invalid inputs.
