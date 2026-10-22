I wrote `bot.mjs` in the working directory. It exports `createPushGate()`, has no dependencies, and runs on Node 22. Its self-check passes. Nothing is sent.

**How it decides**
- **Local time:** Quiet hours and the daily cap use the user's `timeZone`, through `Intl`. Quiet hours include `quietStart` and exclude `quietEnd`, and a window whose start is later than its end wraps past midnight. The check runs in each call's zone, so it stays correct across DST.
- **Per day:** The cap counts allowed pushes per user per local calendar day, which resets at the user's midnight. It is not a rolling 24 hours.
- **Order of checks:** `invalid_user`, `invalid_now`, `unknown_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`, then `quiet_hours`, then `daily_cap_reached`. A send that breaks both quiet hours and the cap reports `quiet_hours`.
- **Counting:** Only `allowed: true` adds to the count. The count is synchronous, so two calls in a row can't both slip past the cap.
- **State:** History is in memory, per `createPushGate()` instance, as you asked. It does not survive a restart.

**Choices I made**
- `quietStart` equal to `quietEnd` means no quiet period. Malformed or missing quiet times are held with `invalid_quiet_hours`, not treated as "no quiet hours".
- I added no minimum gap between pushes. Your request didn't ask for one, so I left it out. If the nudges still feel too frequent, a spacing rule is the next thing to try.
- There is no consent or opt-out field in the data, so none is checked. The body of the message is not checked either.

**Self-check** (run inline, not saved as a test file)
- Quiet hours: 22:30, 22:00 (start included), and 06:59 are held. 07:00 (end excluded) is allowed.
- Cap: the 3rd push of the local day is allowed, and the 4th and 5th get `daily_cap_reached`. A new local day resets the count.
- `dailyCap: 0`, an invalid zone (`Mars/Base`), a bad quiet time (`7:00`), and an invalid `Date` each return their own code.
- A non-wrapping window (13:00–14:00 New York on DST day) works, and its end is excluded.

My first run failed on a bad expected value in my own test, not in the gate. I fixed the test and reran it.
