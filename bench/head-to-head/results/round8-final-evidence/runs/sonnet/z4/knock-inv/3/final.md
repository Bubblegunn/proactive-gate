`bot.mjs` is written and checked. I'm wrapping up with a summary. No dependencies were needed, so `package.json` is unchanged.

**Rules `decide` applies**
- **Requested:** always sent, and it doesn't use the nudge cap.
- **Reminder:** always sent, and it doesn't use the nudge cap.
- **Inferred:**
  - **Grace period:** held for 48 hours, counted from the later of `createdAt` and `profileCreatedAt`. A missing or future date counts as brand new.
  - **First week:** at most 1 suggestion per day, even if `dailyNudgeCap` is higher.
  - **Quiet hours:** held from 21:00 to 08:00 in the user's timezone. An invalid timezone also holds the suggestion.
  - **Daily cap:** `config.dailyNudgeCap`, counted per day in the user's timezone. A missing or invalid value falls back to 1.
- **Repeat calls:** the same `candidate.id` is delivered once. Later calls return `already_delivered`.

**State**
- State is one JSON file per user in `STATE_DIR`, so it survives a restart.
- Each decision runs under a per-user lock file, and writes go through a temp file and rename. Stale locks are cleared after 10 seconds.

**Reason codes**
- `REASON_CODES` has 10 entries, and none says "error".
- Delivered notifications also return a code (`sent_requested`, `sent_reminder`, `sent_suggestion`). I did this because the spec didn't say what to return when `send` is true. If the app should get no code on a send, those three can be dropped.
- The rest are `new_user_grace`, `daily_nudge_cap_reached`, `quiet_hours`, `unknown_timezone`, `already_delivered`, `unsupported_origin` and `invalid_request`.

**Checks run (nothing was sent)**
- Requested notifications go out, and a repeat call is blocked.
- With a cap of 2, the third suggestion of the day is blocked.
- Quiet hours, a new user, an invalid timezone and the next-day reset all behave as intended.
- A user in their first week gets 1 suggestion per day even when the cap is 5.
- Eight processes calling at once with cap 2 delivered exactly 2.

I removed the test scripts and state from `/tmp` afterwards.
