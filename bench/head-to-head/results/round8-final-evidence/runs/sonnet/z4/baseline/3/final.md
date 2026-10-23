`bot.mjs` is written, and my checks passed. It has no dependencies, so `package.json` is unchanged.

**Rules in `decide`**
- **`requested` and `reminder`:** always delivered, including to new users and during quiet hours, because the user asked for them. They don't count toward the nudge cap.
- **`inferred`:** sent only if all three hold:
  - **New-user wait:** the account and the profile are both at least 48 hours old. Missing or invalid dates count as brand new.
  - **Quiet hours:** local time in `user.timezone` is between 08:00 and 21:00. An invalid timezone falls back to UTC.
  - **Daily cap:** fewer than `config.dailyNudgeCap` inferred nudges have been delivered today in the user's local time. A missing or invalid cap counts as 0, so nothing is sent.
- **Repeat candidate ids:** the same id for the same user is never delivered twice (`already_delivered`).
- **Reason codes:** `REASON_CODES` has 8 codes. Three are returned with `send: true` (`requested_ready`, `reminder_due`, `suggestion_allowed`), and none says "error".
- **State:** one JSON file per user in `STATE_DIR`, written atomically and guarded by a lock directory. A stale lock is broken after 10 seconds.

**What I ran**
- Cap 2 with three inferred candidates: the first two were sent and the third got `daily_cap_reached`.
- An inferred candidate at 23:00 local time got `quiet_hours`.
- A reminder at 03:00 local time was sent.
- A brand-new user got `new_user_grace_period` for an inferred candidate but received a requested one.
- 20 concurrent calls in one process with cap 2 sent exactly 2.
- 6 separate Node processes × 5 calls each, all for one user with cap 3, sent 3 in total.

The 48-hour wait, the 08:00–21:00 window and the choice to leave `requested` and `reminder` uncapped are my own defaults, since your spec didn't give numbers. They are constants at the top of the file if you want different values.
