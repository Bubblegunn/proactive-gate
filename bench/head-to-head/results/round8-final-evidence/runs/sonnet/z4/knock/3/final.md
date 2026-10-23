`bot.mjs` is written in the current folder, and my checks passed. It needs no dependencies, so `package.json` is unchanged.

**Rules**
- **Requested and reminder:** both are always delivered. Neither counts toward the daily cap.
- **Inferred:** a suggestion is delivered only when all of these hold:
  - `dailyNudgeCap` is at least 1.
  - The user is at least 24 hours past the later of `createdAt` and `profileCreatedAt`.
  - The local time in the user's timezone is between 08:00 and 22:00.
  - Fewer than `dailyNudgeCap` suggestions went out today, local day.
  - During the first 7 days, at most 1 suggestion per local day.
- **Duplicates:** a requested or inferred candidate with an id that was already delivered is not delivered again. Reminders skip this check, because a recurring reminder may reuse its id.
- **Reason codes:** `REASON_CODES` has 8 codes, none of them an error. They are `already_delivered`, `new_user_warmup`, `new_user_daily_limit`, `daily_nudge_cap_reached`, `nudges_disabled`, `quiet_hours`, `unknown_user_timing` and `unknown_origin`.
- **When `send` is true:** `reasonCode` is `null`. Your spec only requires a code when `send` is false.

**State**
- Each user has one JSON file in `STATE_DIR`, written atomically, so it survives a restart.
- A per-user lock file makes concurrent workers safe, and a lock left by a crashed process is removed after 10 seconds.

**Checks**
- **Cases:** the cap, the duplicate check, quiet hours and the next-day reset behave as listed above. A new user is blocked from suggestions, but a requested notification still goes through.
- **Concurrency:** 12 parallel processes with a cap of 2 delivered exactly 2 suggestions.
- **Restart:** a new process after those runs still saw the earlier count.

**Choices of mine**
- **Policy values:** the 24-hour warm-up, the first-week limit of 1 per day and the quiet hours of 22:00–08:00 are my choices. They are constants at the top of the file if you want different values.
- **Invalid timezone:** an invalid timezone falls back to UTC.

The throwaway test script is in `/tmp/botcheck`, outside the project.
