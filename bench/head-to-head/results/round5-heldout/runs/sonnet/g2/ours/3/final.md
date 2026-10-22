`bot.mjs` is written and exports `createPushGate()`. My self-check script passed on Node 24.13. I haven't run it on Node 22 itself. It sends nothing.

I wrote the gate inline instead of using the proactive-gate library. The skill's own default is an inline file. Where the skill's rules conflicted with your spec, I followed your spec: in-memory history and snake_case reason codes.

**What it checks, in this order**
1. **Invalid input** is held, never guessed:
   - `invalid_user`
   - `invalid_time`
   - `invalid_time_zone` (unknown IANA zone)
   - `invalid_quiet_hours` (not strict `HH:MM`)
   - `invalid_daily_cap` (not an integer of 0 or more)
2. **`quiet_hours`:** the user's local time in their `timeZone`. The start minute is included and the end minute is excluded, so 22:00–07:00 blocks 22:00 and allows 07:00. A window whose start is later than its end wraps past midnight.
3. **`daily_cap_reached`:** counts pushes the gate allowed to that user on the same calendar day in the user's own time zone. A day resets at the user's local midnight, not at UTC midnight. Only allowed calls count, so refused attempts spend nothing.

**What I checked**
- A normal call returns `{ allowed: true, reason: null }`.
- The quiet-window edges and the wrap past midnight.
- A same-day window (12:00–13:00) with no wrap.
- The cap, including cap 0.
- The reset at local midnight, using Tokyo and Los Angeles users.
- Two gates keep separate histories.
- The invalid-input codes.

**Choices to confirm**
- `quietStart` equal to `quietEnd` means no quiet window. I chose that because the spec doesn't say.
- There is no minimum gap between pushes. Apple's and Google's guidance favours spacing, but you only specified a cap and quiet hours. A gap would be a one-line addition if you want it.
- A user who changes `timeZone` mid-day has earlier pushes counted by the new zone's calendar day.

The check script is at `/tmp/check_bot.mjs`, outside the repo.
