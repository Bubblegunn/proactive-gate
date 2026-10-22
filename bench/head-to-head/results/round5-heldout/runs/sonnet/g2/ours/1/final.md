`bot.mjs` is written and passes my self-check script. It exports `createPushGate()`, which returns `{ attempt(user, now) }`. It sends nothing.

I wrote the gate inline rather than installing the proactive-gate library, because you asked for no dependencies and in-memory history. I also ignored the skill's file-based state and plain-sentence refusals, because you asked for in-memory history and snake_case codes.

**What it does**
- **Quiet hours:** it checks the user's local time in `timeZone`, and handles DST. The window includes `quietStart` and excludes `quietEnd`, and wraps past midnight when start is later than end. It returns `quiet_hours`.
- **Daily cap:** "day" is the user's own calendar day in their zone, not UTC or server time. A user at 23:30 and 00:30 local gets two different days. It returns `daily_cap_reached`.
- **What counts:** only calls that return `allowed: true` count toward the cap. Refused calls cost nothing.
- **Settings per call:** history is kept per user id, but the zone, quiet hours and cap come from the `user` object passed in each call. Each gate has its own history.

**Reason codes**
- **Refusals:** `quiet_hours`, `daily_cap_reached`.
- **Bad input:** `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`. Bad input is held, never guessed. This is deliberate, because wrongly sending at night is worse than missing one nudge.
- **Allowed:** `reason` is `null`.

**Choices I made**
- If `quietStart` equals `quietEnd`, I treat that as no quiet hours.
- `dailyCap: 0` blocks everything, with `daily_cap_reached`.
- There is no minimum gap between pushes, since you listed only the cap and quiet hours. A user can get all three pushes within a minute. If that bothers users, a one-hour gap would be one more rule with its own code.

**Checked**
- The self-check is in `/tmp/check.mjs`. It covers a normal allowed push in Tokyo and the quiet-window edges (22:00 blocked, 21:59 blocked, 07:00 allowed).
- It also covers the cap of 3 and the reset on the next local day. For the local-day case, a Los Angeles user with a cap of 1 across local midnight gets two sends on different local days.
- Finally, it checks that an invalid zone is refused and that two gates have independent history.

I ran it on Node 24; I didn't test Node 22 itself.
