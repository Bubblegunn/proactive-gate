`bot.mjs` is written and exports `createPushGate()`. My checks passed after I fixed one wrong assertion in my own test. I ran them on Node 24 here, not Node 22, and nothing was sent.

**Quiet hours** are checked first, in the user's own time zone.
- The window start is inclusive and the end is exclusive, so 22:00 is quiet and 07:00 is not.
- A window that runs past midnight works, and so does a daytime window.
- If `quietStart` equals `quietEnd`, I treat that as no quiet hours.
- A refusal returns `quiet_hours`.

**The daily cap** counts pushes per local calendar day, midnight to midnight in the user's zone.
- A Los Angeles user at 18:00 is still on the same day even though UTC has rolled over.
- The count resets at local midnight, including on a daylight-saving change day.
- A refusal returns `daily_cap_reached`.

**Settings and history:**
- Settings are read from each call, not remembered, so a changed time zone or cap applies immediately.
- Only allowed calls are recorded. A refused call never uses up the cap.
- History is kept per gate and per user, and entries older than 72 hours are dropped.

**Bad input fails closed.** I chose this so a bad setting can't wake someone up. Each case has its own code:

| Code | Cause |
|---|---|
| `invalid_user` | `user` is missing, or its `id` is missing or empty |
| `invalid_time` | `now` is not a valid Date |
| `invalid_time_zone` | the time zone is unknown |
| `invalid_quiet_hours` | a quiet-hours string is not valid HH:MM |
| `invalid_daily_cap` | `dailyCap` is not an integer of 0 or more |

A cap of 0 blocks everything.

I did not add a minimum gap between pushes, because you only asked for the cap and quiet hours. Say so if you want one.

The check script is `/tmp/t.mjs`, outside the repo. It covers:
- the quiet-window edges
- the Tokyo and Los Angeles cases
- users and gates being independent
- refused calls not counting
- a daylight-saving change day
- the invalid inputs
