`bot.mjs` is written and exports `createPushGate()`. My throwaway test script passed, and nothing was sent. The script is `/tmp/t.mjs`, outside the repo.

**Rules, checked in this order**
1. **`quiet_hours`:** the user's local time, from `timeZone`, falls inside `[quietStart, quietEnd)`. Windows that run past midnight, like 22:00–07:00, work. The start minute is quiet and the end minute is not.
2. **`daily_cap_reached`:** the user already has `dailyCap` allowed pushes on the same local calendar day. The day resets at the user's local midnight, not UTC midnight.

**Behaviour**
- Only calls that return `allowed: true` count toward the cap. Blocked attempts don't.
- Settings are read from each call. Changing `dailyCap`, the quiet hours or the zone takes effect on the next call.
- Each `createPushGate()` has its own history, kept per user id in memory. Entries older than 3 days are dropped.
- Bad input fails closed with its own code instead of throwing: `invalid_time` (`now` is not a valid Date), `invalid_time_zone`, and `invalid_user_settings` (bad `id`, HH:MM or `dailyCap`).
- `dailyCap: 0` blocks every push.

**What the test covered**
- Overnight quiet windows, including the edges (22:00 and 07:00 in Tokyo).
- Cap reset at local midnight.
- A New York user's day not resetting at UTC midnight.
- A same-day quiet window and a cap of 0.
- Per-call settings, independent gates and invalid input.
- US spring-forward DST day.

**Choices to check**
- **Equal start and end:** `quietStart` equal to `quietEnd` means no quiet hours. The alternative is "quiet all day", which would silence the user completely. Say if you want that instead.
- **Day boundary:** the cap counts a local calendar day, not a rolling 24 hours. A user can get a push at 20:00 and the next at 08:00 that day-boundary morning. A rolling window would be stricter if you prefer it.
- **Courier skill:** it points to Courier send limits and delivery windows for caps and quiet hours. I kept this in the gate as you asked. Courier's send limits can only be set in its app, and neither feature is configurable from code.
- **Platform guidance:** I applied the Apple and Google guidance as respecting the user's chosen quiet hours and cap. I didn't add rules the user didn't set, such as minimum spacing between pushes.
