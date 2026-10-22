`bot.mjs` is written and my checks pass (run with Node, `/tmp/gate-check/check.mjs`). Nothing was sent.

`createPushGate()` returns `{ attempt(user, now) }`. Each gate keeps its own in-memory history, and it uses the settings passed in on each call. Rules run in this order:

1. **`invalid_settings` / `invalid_time`:** if the zone, the HH:MM strings, `dailyCap` or `now` can't be read, the push is blocked. A bad input won't produce a push at the wrong time.
2. **`quiet_hours`:**
   - The user's local time (their IANA zone) is checked against `[quietStart, quietEnd)`.
   - A window like 22:00–07:00 is handled across midnight.
   - If start equals end, I treat that as no quiet period. That was my call, so say if you want it to mean the whole day.
3. **`daily_cap_reached`:**
   - "Day" is the user's local calendar day, not UTC and not a rolling 24 hours. A user in Tokyo gets a fresh allowance at their own midnight.
   - Only allowed attempts count toward the cap. Blocked attempts don't use it up.
   - `dailyCap: 0` blocks everything with this code.

Quiet hours are checked before the cap, and daylight saving time is handled by the zone.

I found no Apple or Google guidance in the Knock skill rules, so I followed what the skill does say. It lists respecting quiet hours, frequency caps and user-configurable limits as the way to avoid notification fatigue. I did not search for the Apple and Google guidance themselves.

The checks cover:
- quiet-hours boundaries on both sides of midnight, in Tokyo, and in New York with daylight saving
- the cap resetting at local midnight, and two pushes on one local day counting together even though they fall on different UTC days
- blocked attempts not counting toward the cap
- independent gates and users, and settings changing between calls
- invalid input returning distinct codes

The test file is in `/tmp`, not in the repo.
