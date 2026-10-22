`bot.mjs` is written and exports `createPushGate()`. My inline checks pass on Node 24.13. I did not test on Node 22 itself or write a test file.

**How it decides**
- **Quiet hours:** The gate uses the user's own local time, from `timeZone` through `Intl`. The start minute is quiet and the end minute is not. When start is later than end, the period wraps past midnight. With the Tokyo user, 22:00 is blocked, 21:59 is allowed and 07:00 is allowed. The New York clock change on 2026-11-01 also behaves correctly.
- **Daily cap:** The count covers the user's own local calendar day, so it resets at their midnight and not at UTC midnight. Only pushes the gate allowed are counted. Refused attempts cost nothing.
- **Order of checks:** Settings are validated first, then quiet hours, then the cap. The quiet-hours check runs before the cap check, so a push blocked by quiet hours never counts toward the cap.
- **State:** History is in memory only, and each gate keeps its own. Each call uses the settings passed in that call. History older than 48 hours is dropped.

**Reason codes:** `quiet_hours`, `daily_cap_reached`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`, `invalid_user` and `invalid_now`. A bad or missing setting blocks the push, because the gate does not guess the user's time or limits.

**Choices you may want to change**
- `quietStart` equal to `quietEnd` means no quiet period. It does not mean all day.
- `dailyCap: 0` blocks every push.
- I did not add a minimum gap between pushes. The cap and quiet hours are the only blocks you asked for, and a gap would be one more block. Say so if you want one.

**What I checked** (by running inline assertions):
- Tokyo quiet-hours boundaries.
- A cap of 3 allows three pushes and blocks the fourth, and the count resets on the next Tokyo day.
- Pushes before and after UTC midnight count toward the same Tokyo day.
- A second user's history is separate.
- An invalid zone and a cap of 0 are blocked.
- A New York push at 06:30 local on 2026-11-01 (the clock-change day) is blocked as quiet.

The proactive-gate skill's rules about shared on-disk state, opt-out handling and plain-sentence refusals conflict with your instructions. You asked for in-memory history, snake_case reason codes and no consent logic, so I followed your instructions.
