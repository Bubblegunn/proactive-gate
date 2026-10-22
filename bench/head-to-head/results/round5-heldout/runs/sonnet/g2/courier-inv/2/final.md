`bot.mjs` is written and exports `createPushGate()`. Its `attempt(user, now)` returns `{ allowed, reason }`. I checked it with a Node script in `/tmp/check-bot.mjs`, and all checks passed. Nothing was sent, and I didn't add the script to the repo.

**Reason codes**
- `quiet_hours`: the user's local time is inside `quietStart`–`quietEnd`. The window can run past midnight. `quietStart` is inclusive and `quietEnd` is exclusive.
- `daily_cap_reached`: the user already received `dailyCap` pushes today.
- `invalid_user_settings`: the user has no id, a time isn't `HH:MM`, `dailyCap` isn't a non-negative integer, or the time zone isn't a real IANA zone.
- `invalid_time`: `now` is not a valid Date.

**How it works**
- **Day and night:** both are worked out in the user's own `timeZone`. "Per day" means their local calendar day, not the UTC day. The check script covers Tokyo, Los Angeles and a Berlin daylight-saving change.
- **Order of rules:** quiet hours are checked first, then the cap.
- **What counts:** only calls that return `allowed: true` count toward the cap. Blocked calls never do.
- **Per-call settings:** the gate uses the settings passed in each call. If a user's zone or cap changes, past pushes are re-counted under the new zone and the new cap.
- **Memory:** each gate keeps its own history per user and drops entries older than 3 days.
- **Bad input:** invalid input is blocked rather than allowed, so a settings bug can't wake someone up.

**Decisions to check**
- **Equal start and end:** if `quietStart` equals `quietEnd` (for example `"22:00"` and `"22:00"`), I treat it as no quiet period. The other reading is "quiet all day", which would block every push for that user. Say if you want that instead.
- **Frequency rules:** I only added the two rules you asked for. I didn't add a minimum gap between pushes or throttling by topic. Apple and Google guidance both point to restraint and respecting the user's settings, so you may want a gap rule later.
- **Courier:** I read the Courier skill's guidance first. Its frequency limits and delivery windows are Courier-side features. Your agent decides before it calls Courier, so this gate has to run in your own process.
