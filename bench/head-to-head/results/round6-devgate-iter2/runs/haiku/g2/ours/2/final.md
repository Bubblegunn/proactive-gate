Wrote `bot.mjs` in the work directory. It exports `createPushGate()`, and the gate's `attempt(user, now)` returns `{ allowed, reason }`. Nothing is sent. The self-check passed 24 cases.

**Checks, in order**
1. `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`: bad input is held, never guessed.
2. `quiet_hours`: local time in the user's IANA zone. Start is inclusive, end is exclusive. A start later than the end wraps past midnight.
3. `daily_cap_reached`: counts this gate's allowed pushes on the user's local calendar day.

If both quiet hours and the cap apply, `quiet_hours` is returned.

**Choices I made (change any of these if you disagree)**
- "Per day" means the user's local calendar day, not a rolling 24h window. A cap of 3 means three pushes on that day, and the count resets at local midnight.
- `quietStart` equal to `quietEnd` means no quiet period.
- A missing quiet-hours pair means no quiet period. A pair with one side missing or an invalid time is held.
- A refused attempt does not count toward the cap. Only `allowed: true` does.
- `dailyCap: 0` allows no pushes that day.
- History is kept for 48h per user, enough to cover any local day across DST. Users are never evicted from the map, so memory grows with the number of distinct users.

**Assumptions and gaps**
- The input has no consent field, so the gate does not check consent. I read the push as an app nudge the user already opted into through notification settings. If the agent can send promotions, that needs a separate check.
- No opt-out handling. Push has no inbound STOP in this API.
- No message-id idempotency. `attempt` has no id, so every call that returns `allowed: true` counts as one push. The caller must call it once per send.
- State is in memory per gate, as you said. It is shared only within one process and is lost on restart.
- I did not look up Apple or Google's current notification guidance. The design follows the general principles: no pushes at night, a frequency cap, and respect for the user's settings.

**Verification**
- Local runtime is Node v24.13.0. The file uses only standard library features (`Intl`, `Map`, `Date`) and no dependencies, so it should also run on Node 22. I did not run it on Node 22.
