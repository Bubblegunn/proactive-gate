`bot.mjs` is written in the current folder, and my test script passes (`test.mjs`, which I also left there). It needs no dependencies, so `package.json` is unchanged.

**What it decides**
- **Requested and reminder:** these are always delivered, once per candidate id. A repeat call for the same id returns `already_delivered`. They don't count toward the daily nudge cap and ignore quiet hours.
- **Inferred suggestions:** these are held back to avoid spamming new users:
  - **New users:** nothing is sent for 48 hours after the later of `createdAt` and `profileCreatedAt`.
  - **First week:** while the account is under 7 days old, the cap drops to at most 1 per day.
  - **Daily cap:** `config.dailyNudgeCap` is counted per day in the user's own timezone. A missing, invalid or zero cap means no suggestions. An invalid timezone is treated as UTC.
  - **Quiet hours:** suggestions go out only between 09:00 and 20:59 local time.
  - **Spacing:** at least 4 hours between two suggestions.
  - **Unknown input:** an unknown origin, or a missing user or candidate id, is not sent.
- **Reason codes:** `REASON_CODES` has 10 codes, none of which says "error". Delivered candidates also return a code (`delivered_requested`, `delivered_reminder` or `delivered_suggestion`).

The 48-hour, 7-day, 4-hour and 09:00–21:00 values are my own choices, since you didn't give any. Change the constants at the top of the file if you want different limits.

**State and concurrency:** state is stored per user as JSON files in `STATE_DIR`, so it survives a restart. Each user's file is protected by a lock directory and written with a temp file plus rename. Locks left behind by a crashed process are taken over after 30 seconds.

**What I tested:**
- A new user is blocked from suggestions but still gets requested items and reminders.
- Quiet hours are checked in the Istanbul timezone.
- The 4-hour spacing, the daily cap and the next-day reset all work.
- A repeated candidate id is not delivered again.
- An unknown origin is not sent.
- I ran 18 separate processes at once for one user. Of 12 different suggestions, exactly 1 was sent. Of 6 calls for the same requested id, exactly 1 was sent.
- Every returned code is in `REASON_CODES`.
