`bot.mjs` is written and exports `createPushGate()`. My check script passes, and it never sends anything. The script is `/tmp/gate-check.mjs`, outside the repo. It covers:
- a quiet window that crosses midnight (Tokyo);
- the cap and the day reset;
- the local-day boundary in Los Angeles;
- a same-day quiet window;
- two gates that don't share history, and settings changed between calls;
- the daylight-saving change in New York;
- bad input.

I didn't try the "ignore quiet hours for urgent pushes" case, since `attempt` has no urgency input.

`attempt(user, now)` checks the rules in this order, and the first one that matches decides the result:

| Order | Reason code | When it stops the push |
|---|---|---|
| 1 | `invalid_time` | `now` is not a valid Date. |
| 2 | `invalid_user_settings` | The id, time zone, `HH:MM` strings or `dailyCap` can't be used. |
| 3 | `quiet_hours` | The user's local time is inside the quiet window. |
| 4 | `daily_cap_reached` | The user has already had `dailyCap` pushes today. |

If none match, it returns `{ allowed: true, reason: null }` and records the push.

Choices I made where the request left room:
- **"Day"** means the calendar day in the user's own time zone, midnight to midnight, not UTC and not a rolling 24 hours. Someone in Los Angeles gets a fresh count at their own midnight.
- **"Night"** means the user's own quiet window in their own zone. Start is inclusive and end is exclusive, so 07:00 is allowed and 22:00 is blocked.
- **Daylight saving** is handled, because the day is worked out from the zone's calendar rather than by adding 24 hours.
- **Blocked attempts don't count.** A push stopped by quiet hours doesn't use up the cap.
- **Quiet hours are checked before the cap.** If both apply, you get `quiet_hours`.
- **Settings are read from each call.** If a user changes their cap or zone, the next call uses it. Past pushes are re-counted by the new zone's days.
- **`dailyCap: 0` blocks everything** with `daily_cap_reached`.
- **`quietStart` equal to `quietEnd`** means no quiet window. Say so if you'd rather treat it as quiet all day.
- **Bad settings block the push** (`invalid_user_settings`) rather than sending. That includes an unknown time zone, a malformed `HH:MM` string or a negative cap. A push that wakes someone up costs more than a missed nudge.
- **History is kept only for the last 72 hours.** That is enough to count today and keeps memory small.

I added no minimum gap between pushes, since you didn't ask for one and it would be an extra rule you hadn't specified. If bursts are a complaint, a gap could be added with its own reason code.
