`bot.mjs` is written and works. It has no dependencies, so `package.json` is unchanged. I ran a test script against a temporary `STATE_DIR`. It covered the rules below, 20 concurrent calls for one user, and a restart: a fresh process saw state saved by the earlier run. All of it passed. I did not add the test script to the folder.

**How `decide` chooses**
- **Requested:** always delivered, because the user asked for it. It does not count toward the daily nudge cap.
- **Reminder:** always delivered, even in quiet hours. It does not count toward the cap.
- **Inferred:** delivered only if all of these hold, checked in this order:
  - **Cap:** `config.dailyNudgeCap` is a number of 1 or more. If it is missing or less than 1, no inferred nudge is sent.
  - **New users:** the account is at least 3 days old. The age is measured from the later of `createdAt` and `profileCreatedAt`. If neither date parses, the user is treated as new.
  - **Quiet hours:** the local time in `user.timezone` is between 09:00 and 21:00. An invalid timezone falls back to UTC.
  - **Daily limit:** fewer than `dailyNudgeCap` inferred nudges have been delivered today in the user's local day.
  - **Spacing:** at least 4 hours since their last inferred nudge.
- **Repeats:** a candidate id that was already delivered returns `already_delivered`, so the same notification is never sent twice.
- **Bad input:** a missing user or candidate, or an invalid `now`, returns `invalid_request`. An unknown origin returns `unknown_notification_type`.

The 3-day grace period, the 4-hour spacing and the 09:00–21:00 window are values I chose. They are constants at the top of `bot.mjs` if you want different ones.

**Reason codes**
- **`REASON_CODES`:** it lists every code `decide` can return, including the three "sent" codes (`sent_requested`, `sent_reminder`, `sent_suggestion`). None of them says "error".
- **Not-sent codes:** `already_delivered`, `new_user_grace_period`, `daily_limit_reached`, `too_soon_after_last_suggestion`, `quiet_hours`, `suggestions_unavailable`, `unknown_notification_type` and `invalid_request`.

**State**
- **Layout:** each user gets one JSON file in `STATE_DIR`, created if missing, so it survives restarts.
- **Concurrency:** a per-user lock file serializes the read-decide-write step across processes, and the file is replaced atomically on each write. In the 20-call test only one inferred nudge went through.
- **Stale locks:** a lock older than 10 seconds is treated as left by a crashed worker and removed. That removal is not fully race-free, but it only matters after a crash.
- **Delivery counting:** `decide` records a candidate as delivered at the moment it returns `send: true`.
- **Missing `STATE_DIR`:** `decide` throws if the variable is not set.
