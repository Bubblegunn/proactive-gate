`bot.mjs` is written and passed my checks. I wrote the checks in `/tmp/botcheck/check.mjs`, outside the project folder. It uses no dependencies and sends nothing.

**How `decide` behaves**
- **Requested and reminder:** these always deliver, including to brand-new users and at night. The user asked for them. They don't count against `dailyNudgeCap`.
- **Inferred suggestions** are held back unless all of these pass:
  - **New users:** the user's age counts from the later of `createdAt` and `profileCreatedAt`. A suggestion is held back for the first 3 days after that. For the next 11 days the cap is at most 1 per day.
  - **Quiet hours:** 21:00 to 09:00 in the user's own timezone.
  - **Daily cap:** at most `config.dailyNudgeCap` per local calendar day, per user.
  - **Bad input:** an invalid timezone or an unusable cap also holds the suggestion back. Missing or invalid dates count as a brand-new user.
- **Repeats:** a candidate id that was already delivered is not sent again.
- **Failures:** `decide` never throws. If the state can't be read or written, it returns `busy_try_again` and sends nothing.

**State and concurrency**
- State is one JSON file per user in `STATE_DIR`. It is created if missing and is written to disk safely, so it survives a restart.
- A per-user lock makes the check and the record a single step across worker processes. A stale lock is taken over after 10 seconds.

**Reason codes**
- **Delivered:** `sent_requested`, `sent_reminder`, `sent_suggestion`.
- **Held back:** `already_delivered`, `new_user_no_suggestions_yet`, `quiet_hours`, `daily_limit_reached`, `timezone_unknown`, `suggestions_unavailable`, `busy_try_again`.
- **Bad candidate:** `unsupported_origin`, `invalid_candidate`.
- No code says "error".

**What I checked**
- Cap and repeat handling, the cap resetting on the next local day, quiet hours, and new-user blocking.
- The reduced cap for users in their first two weeks, and an invalid timezone.
- Requested and reminder going through for a new user at night.
- Twelve worker processes racing for one user with a cap of 2: exactly 2 sent.
- A fresh process after that sent nothing more, so the state persisted.

The 3-day wait, the 14-day ramp and the 21:00–09:00 quiet window are my choices, not from the spec. They are constants at the top of `bot.mjs` if you want different values.
