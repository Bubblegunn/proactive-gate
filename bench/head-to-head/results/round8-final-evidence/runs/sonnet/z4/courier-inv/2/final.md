`bot.mjs` is written in the current folder, and `node check.mjs` passes. I ran it under Node v24.13.0 here, not Node 22. It has no dependencies, so `package.json` only sets `"type": "module"` and the Node engine.

The rules in `decide`:
- **"requested" and "reminder":** these always send, even to a brand-new user and even at night. They don't count against the nudge cap. A second call with the same `candidate.id` returns `already_delivered`, so nothing goes out twice.
- **"inferred" nudges:** these are held back unless all of these are true:
  - **Valid cap:** `config.dailyNudgeCap` is a number of at least 1. A missing or invalid value means no nudges.
  - **Account age:** the account is at least 48 hours old. Age counts from the newer of `createdAt` and `profileCreatedAt`. Missing or invalid dates are treated as brand new.
  - **Quiet hours:** local time in `user.timezone` is between 08:00 and 21:00. An invalid timezone falls back to UTC.
  - **Spacing:** at least 4 hours have passed since the last nudge.
  - **Daily cap:** fewer than `dailyNudgeCap` nudges went out today. "Today" is the local calendar day. For the first 14 days the cap is at most 1 per day.
- **Unknown origin or bad input:** returns `unknown_origin` or `invalid_candidate`.

State lives in `STATE_DIR`, one JSON file per user. A lock file guards each read and write, and writes go through a temp file and rename, so they survive a restart and are safe across worker processes. A lock left behind by a crashed process is taken over after 15 seconds.

`REASON_CODES` also lists the codes returned on `send: true` (`requested_ready`, `reminder_due`, `nudge_allowed`). None of them says "error".

`check.mjs` covers:
- **Local time:** quiet hours and the daily reset in Istanbul time.
- **Cap and new users:** the cap, the new-user grace period and the new-user limit of 1 per day.
- **Deduplication:** repeated candidate ids.
- **Bad input:** invalid timezone and dates.
- **Concurrency:** four real processes making 20 attempts for one user, which produced exactly one send.

The thresholds are my choices, not yours: 48-hour grace, 14-day new-user period, 4-hour gap, 21:00 to 08:00 quiet hours. They are constants at the top of `bot.mjs`.

I overwrote an existing `package.json` without reading it first; git shows the whole folder as untracked, so I can't diff what was there.
