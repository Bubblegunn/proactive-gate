`bot.mjs` is written in the current folder and I tested it. It has no dependencies, so `package.json` is unchanged.

**What I ran**
- **Rules:** 22:00 is blocked, 07:59 is blocked and 08:00 is allowed. The cap resets at local midnight, and a user without consent is never sent anything.
- **Concurrency:** 8 processes sent 80 notifications for one user on the same day. Exactly 3 were delivered, and all 80 were logged.
- **Stale lock:** a lock left by killed workers was cleared automatically after about 15 seconds. The next `decide` call then ran normally.
- **Daylight saving time:** a New York case on the spring-forward day gave the correct `availableAt` of 12:00Z.
- **`dryRun`:** with quiet hours 22:00–08:00 and a cap of 3, 6 test events gave 3 delivered and 3 blocked. With `quietHours: null` and `dailyCap: null`, all 6 were delivered.

**How it behaves**
- **`decide`:** checks consent, then quiet hours, then the daily cap. Blocked notifications don't count toward the cap.
  - **Concurrency and restarts:** state lives in `STATE_DIR`, one file per user, protected by a lock that works across processes. It survives restarts.
  - **Missing or invalid timezone:** the notification is blocked and logged with the rule code `INVALID_TIMEZONE`.
- **Retries:** once a notification is delivered, calling `decide` again with the same ID returns `send: true` without sending or counting again. A blocked notification is re-evaluated on retry, so it can still go out later. Its entry moves to the end of the log, so support sees one entry per notification.
- **`whyNotReceived`:** returns entries with `at` in `[from, to)`, in the order they were considered. Rule codes are `NO_CONSENT`, `QUIET_HOURS`, `DAILY_CAP` and `INVALID_TIMEZONE`. `availableAt` is the end of quiet hours, or the next local midnight pushed past quiet hours for the cap. It is `null` for no consent and for an invalid timezone.
  - **Text:** `text` is a sentence in the customer's local time.
- **`dryRun`:** never reads or writes `STATE_DIR` and sends nothing. It sorts events by time and counts the cap per user per local day. It still blocks users without consent, since consent isn't part of the candidate policy. It also treats every event on its own, so a duplicate notification ID is counted as a second event rather than merged.

Two limits: if a local time falls in a daylight-saving gap, `availableAt` lands just after the gap. Also, the text hardcodes the live policy's "3" and "22:00 to 08:00", so it needs updating if the live policy changes.
