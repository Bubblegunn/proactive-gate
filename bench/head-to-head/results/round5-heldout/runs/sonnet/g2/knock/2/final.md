`bot.mjs` is written and exports `createPushGate()`. My check script passed (`/tmp/gate_check.mjs`, outside the repo). Nothing was sent.

`attempt(user, now)` checks these in order:

1. **Quiet hours** (`quiet_hours`)
   - The window is read in the user's own `timeZone`.
   - It can cross midnight, for example 22:00–07:00.
   - The start time is inside the window and the end time is outside it, so 22:00 is blocked and 07:00 is allowed.
   - If `quietStart` equals `quietEnd`, there is no quiet period.
2. **Daily cap** (`daily_cap_reached`)
   - "Day" is the user's local calendar day, not the UTC day. A push at 23:30 and one at 00:30 local time count toward different days.
   - Daylight-saving days work, because the code compares calendar dates and does not count 24-hour spans.
   - The cap is the `dailyCap` passed in that call. A cap of 0 blocks everything.

Only allowed attempts count toward the cap. A push blocked by quiet hours or by the cap does not use up the user's allowance. History is kept per user inside each gate and pruned to the last 48 hours.

If the input is invalid, `attempt` blocks the push and gives a separate reason code: `invalid_time`, `invalid_user`, `invalid_time_zone`, `invalid_quiet_hours` or `invalid_daily_cap`. I chose this so a bad settings value can never cause a late-night push.

The check covered:
- Both ends of a midnight-crossing window.
- Day boundaries in Tokyo and Los Angeles.
- A daytime-only window.
- Settings that change between calls.
- Separate users and separate gates.
- The 2026 US daylight-saving change.
- Invalid input.

I did not add a minimum gap between pushes, because you only asked for quiet hours and a daily cap. If three pushes in a few minutes still annoys users, a minimum gap would be a small addition.
