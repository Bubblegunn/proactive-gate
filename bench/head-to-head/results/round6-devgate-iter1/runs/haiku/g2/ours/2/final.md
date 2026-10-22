Wrote `bot.mjs` in the working directory. It exports `createPushGate()`, and `attempt(user, now)` returns `{ allowed, reason }`. Nothing is sent. The self-check passes on Node v24.13.0.

**Rules, in order:**
1. **Invalid input is held:** bad user id, bad `now`, unknown or invalid IANA zone (`invalid_user`, `invalid_now`, `invalid_time_zone`), malformed `quietStart`/`quietEnd` (`invalid_quiet_hours`), or a non-integer or negative `dailyCap` (`invalid_daily_cap`).
2. **Quiet hours** (`quiet_hours`): evaluated in the user's local time. The start minute is included and the end minute excluded. If start is later than end, the window wraps past midnight. Equal start and end means no quiet period. DST is handled because the zone is converted with Intl for each call.
3. **Daily cap** (`daily_cap_reached`): counts allowed pushes per user per recipient-local calendar day, so the count resets at the user's local midnight, not UTC. `dailyCap: 0` blocks everything.

Each `createPushGate()` call has its own in-memory history, and each call reads the settings it is given.

**Self-check results:**
- Quiet window: 23:00 JST is blocked; 07:00 JST is allowed (end excluded); 21:59 JST is allowed.
- Cap: the 4th push with `dailyCap: 3` is blocked; the next local day resets the count; a second user is counted separately.
- Holds: invalid zone, bad quiet time, bad `now`, and `dailyCap: 0` each return the expected code.
- DST: on 2026-11-01 in New York, 06:30 EDT is quiet and 07:00 EST is allowed.

One check in my first run failed, and the fault was in my test. 00:30 JST falls inside the 22:00–07:00 quiet window, so `quiet_hours` was correct. I re-ran the day reset with a 02:00–03:00 window, and it passed.

**Choices to review:**
- **No extra blocks.** I added no cooldown, minimum gap, or rate limit, because you did not ask for them. Adding one is a small change if you want it.
- **Reason is a code, not a sentence.** The skill's guidance asks for a plain sentence, but your contract specifies a snake_case code, so I kept the code.
- **State is in memory only,** as you said. It is not shared across processes or restarts. The skill's default is shared state on disk, which I did not use.
- **Library not used.** I did not check whether the project already imports `proactive-gate`. The task is small, so I wrote the gate inline.
- **No opt-out or consent handling.** The fields you listed don't include them, so the gate does not check them.
