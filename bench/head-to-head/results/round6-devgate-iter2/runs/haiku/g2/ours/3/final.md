I wrote `bot.mjs` in the working directory. `createPushGate()` returns `{ attempt(user, now) }`. Nothing is sent. All checks passed.

**How it decides**, in order:
1. **Invalid input is held, with a distinct code:** `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`. A missing field counts as invalid, not as "off".
2. **Quiet hours** are checked in the user's local time from `timeZone`. The start minute is included and the end minute is excluded. A window whose start is later than its end wraps past midnight. Blocked with `quiet_hours`.
3. **Daily cap** counts allowed pushes on the user's local calendar day, not UTC. Blocked with `daily_cap_reached`. A cap of 0 blocks everything.
4. If all checks pass, the push is recorded and the call returns `{ allowed: true, reason: null }`.

Quiet hours are checked before the cap, so a blocked quiet-hours attempt never counts against the day.

**Choices I made:**
- **Equal `quietStart` and `quietEnd`** mean no quiet period. The window is empty.
- **State is in memory per gate**, as you asked. I did not add a `STATE_DIR` file. Two processes would each keep their own history.
- **No minimum gap between pushes.** Apple and Google advise against excessive notifications, but they give no number, and you asked for a daily cap and quiet hours only. If you want a gap (for example, one push per 2 hours), it is a small addition. Tell me the number.

**Checks run** (inline assertions, not saved as a file): Tokyo quiet window edges, cap reset at the local midnight, UTC date differing from the Tokyo date, New York quiet hours across the March DST change, each invalid-input code, independent gates, cap 0, and equal start and end. All passed.
