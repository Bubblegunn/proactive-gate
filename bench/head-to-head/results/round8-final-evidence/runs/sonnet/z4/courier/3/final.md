`bot.mjs` is written and tested. It uses only Node built-ins, so I changed nothing in `package.json`. Nothing is actually sent.

**Rules in `decide`**
- **Requested and reminder:** these are always delivered, including during quiet hours and for new users. They don't count against the daily cap.
- **Inferred:** a suggestion is delivered only if all of these hold:
  - The account is at least 3 days old, measured from the later of `createdAt` and `profileCreatedAt`. An unparseable date counts as new.
  - It is not between 21:00 and 08:00 in the user's timezone.
  - The user has fewer than `dailyNudgeCap` inferred nudges delivered on their local calendar day. A missing or invalid cap counts as 0.
- **Duplicates:** a candidate id that was already delivered is never delivered again.
- **Reason codes:** `REASON_CODES` has 9 values: `requested_ready`, `user_reminder`, `inferred_nudge_allowed`, `already_delivered`, `new_user_grace_period`, `quiet_hours`, `daily_nudge_cap_reached`, `unknown_timezone` and `unknown_origin`. None says "error". A delivered result also carries a code, which is the reason it was sent.

**State**
- There is one JSON file per user in `STATE_DIR`, created if missing.
- Each file is written atomically and guarded by a per-user lock file. A lock older than 30 seconds is treated as stale.

**What I ran**
- **Single process:** the decisions came out as expected. The repeat id was refused, the third inferred nudge hit the cap, and the quiet-hours and new-user cases were blocked. Every returned code is in `REASON_CODES`.
- **Concurrency:** 8 separate processes ran at once with a cap of 2. Exactly 2 were delivered and 6 refused.
- **Restart:** a later process on the same `STATE_DIR` still saw the cap as used and refused.

The 3-day grace period and the 21:00–08:00 quiet window are my choices, since you didn't specify them. They are constants at the top of the file if you want different values.
