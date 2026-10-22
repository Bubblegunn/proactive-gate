`bot.mjs` is written and the check passed. It's in the working directory, uses no dependencies, and exports `createPushGate()`.

**What I checked** (one inline run against the real function):
- A Tokyo user got 3 pushes at 12:00, 13:00 and 14:00 JST. The 4th, at 15:00 JST, was refused with `daily_cap_reached`.
- 22:00 JST was refused with `quiet_hours`, and so was 06:59 JST.
- The first allowed push after quiet hours, at 07:00 JST, went through.
- A push at 21:59 JST was refused for the cap, because it falls on the same local day as the first three.
- 14:00 UTC is 23:00 JST, so the gate refused it as quiet hours. That confirms it uses the user's zone, not the server's.
- An invalid zone was refused with `invalid_time_zone`.
- A second `createPushGate()` started with an empty history.

**What I didn't check:** DST transitions, a user changing time zone mid-day, and `quietStart` equal to `quietEnd`. The first two rely on `Intl` and weren't run.

**How it behaves**
- **Reason codes:** `quiet_hours` and `daily_cap_reached` are the two real rules. Bad input gets its own code: `invalid_time`, `invalid_user`, `invalid_time_zone`, `invalid_quiet_hours` or `invalid_daily_cap`. Bad input is refused rather than guessed.
- **Quiet hours:** they include the start minute and exclude the end minute. They are checked in the user's zone. If the start is later than the end, they run past midnight (22:00–07:00).
- **Quiet hours checked first:** a push refused for quiet hours never counts toward the cap.
- **"Per day":** this is the user's own calendar day, midnight to midnight in their zone. It isn't a rolling 24 hours or the server's day. Only calls that returned `allowed: true` count. Each call uses the settings passed in that call, so a change of zone or cap applies from the next call.
- **Memory:** history is a timestamp list per user id, pruned to the last 48 hours.

**Choices that are mine**
- `quietStart === quietEnd` means no quiet period. Tell me if you'd rather treat it as 24 hours of quiet.
- `dailyCap: 0` blocks everything.
- I didn't add a minimum gap between pushes, because you didn't ask for one. Apple's and Google's guidance suggests spacing nudges out, so a gap (for example 2 hours) is a small addition if you want it.
- You said pushes are sent right after an allowed result and nothing needs to survive a restart, so the gate keeps no per-message-id claims.
