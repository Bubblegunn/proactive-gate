`bot.mjs` is written and my check script passes. I have not run it inside the real app. The check script is in `/tmp/botcheck`, outside the project. No dependencies were needed, so `package.json` is unchanged.

**What `decide` does**
- **`requested` and `reminder`:** always sent, because the user asked for them. They skip quiet hours and don't count toward `dailyNudgeCap`.
- **`inferred`:** sent only if all of these hold:
  - The account (the newer of `createdAt` and `profileCreatedAt`) is at least 3 days old. Missing or invalid dates count as new.
  - The user's local time is outside 21:00–08:00. An invalid timezone falls back to UTC.
  - Fewer than `config.dailyNudgeCap` nudges went out that local day. A missing or invalid cap is treated as 1.
- **Duplicates:** a candidate id that was already delivered is not sent again.
- **Reason codes:** `REASON_CODES` has nine codes, none containing "error":
  - `sent_requested`, `sent_reminder`, `sent_suggestion`
  - `already_delivered`
  - `new_user_waiting_period`, `quiet_hours`, `daily_limit_reached`
  - `unknown_notification_type`, `missing_user_details`
- **State:** one JSON file per user under `STATE_DIR`, written atomically and guarded by a lock directory. The file survives restarts and is safe when several processes run at once.

**What the check covered**
- Requested and reminder notifications go out even for a brand-new user, and reminders go out at night.
- A repeated id is rejected.
- Inferred notifications are held back for a new user and during quiet hours.
- The daily cap stops further nudges, and requested notifications don't use it up.
- The cap resets on the next local day.
- With 8 processes sending 5 inferred notifications each against a cap of 3, exactly 3 were sent.

The 3-day wait and the 21:00–08:00 quiet hours are my own choices, set as constants at the top of the file. Change them if the product wants different values.
