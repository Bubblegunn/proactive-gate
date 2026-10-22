`bot.mjs` is written and exports `createPushGate()`. I ran a check script in `/tmp` and every assertion passed. Nothing was sent.

**Rules**, checked in this order:
1. **Quiet hours** return `quiet_hours`. They are read as the user's local time in `timeZone`, so DST is handled. The window can run past midnight. The start time is inside the window and the end time is not. For example, with `22:00` to `07:00`, 22:00 is blocked and 07:00 is allowed.
2. **Daily cap** returns `daily_cap_reached`. "Day" is the user's local calendar day, so the count resets at their local midnight, not UTC midnight. The history stores send times, so it uses the time zone passed in each call.

Only allowed calls count toward the cap. Blocked calls don't. Histories are kept per user per gate and trimmed to the last three days.

**Choices I made where your spec was silent:**
- **Invalid input:** a bad time zone, a malformed `HH:MM`, a bad `dailyCap` or a missing `id` returns `invalid_settings`. An invalid `Date` returns `invalid_time`. A bad input never allows a push.
- **`dailyCap` 0:** always blocks, with `daily_cap_reached`.
- **Equal `quietStart` and `quietEnd`:** treated as quiet hours turned off, not as 24 hours of quiet.
- **No minimum gap between pushes:** I only enforce the cap, because you didn't ask for a gap. A gap of an hour or so would help against bursts, and I can add one.

The check script covers:
- the quiet-window edges
- a window that runs past midnight
- the cap resetting at local midnight in Tokyo, not at UTC midnight
- users being independent of each other
- settings changing between calls
- the DST spring-forward day in New York
- the invalid-input cases

The script is at `/tmp/pushgate-check/check.mjs`. I haven't committed anything.
