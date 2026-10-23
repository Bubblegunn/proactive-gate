`bot.mjs` is written in the project folder. I tested it and it behaves as intended. It has no dependencies, so I didn't touch `package.json`. Nothing is actually sent.

**Rules**
- **`requested` and `reminder`:** always delivered (`requested_ready`, `reminder_due`). They don't count toward the nudge cap.
- **`inferred`:** held back in three cases:
  - **Newly created accounts:** `new_user_grace_period` applies for 48 hours after the later of `createdAt` and `profileCreatedAt`. Unparseable dates are treated as new.
  - **Night hours:** `quiet_hours` applies from 22:00 to 08:00 in the user's timezone. An invalid timezone falls back to UTC.
  - **Daily limit:** `daily_nudge_cap_reached` applies once the user has had `config.dailyNudgeCap` delivered nudges that local day. A missing or invalid cap counts as 0.
- **Repeat calls:** a candidate that was already delivered returns `already_delivered`, so a retry never sends twice.
- **Bad input:** returns `invalid_request`.
- **Reason codes:** none of them says "error".

**State**
- Each user gets one JSON file in `STATE_DIR`, which is created if missing and survives restarts.
- A per-user lock and atomic file replacement keep it safe when several worker processes run at once.
- A lock left behind by a crashed worker is cleared after 10 seconds.

**Test results**
- **Single run:** the first request was delivered and its repeat was refused. With a cap of 2, the third nudge was refused. A nudge at 23:00 local was refused, a brand-new account's nudge was refused, and a reminder was delivered.
- **Concurrency:** 20 simultaneous calls in one process with a cap of 2 delivered exactly 2. Eight separate processes with a cap of 3 delivered exactly 3.

The 48-hour grace period and the 22:00–08:00 quiet window are my own choices, since you gave no values. They are constants at the top of the file if you want different ones.
