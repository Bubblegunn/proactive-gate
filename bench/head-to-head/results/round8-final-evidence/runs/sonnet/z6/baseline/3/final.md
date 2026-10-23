`bot.mjs` is written in the current folder and exports `decide`, `whyNotReceived` and `dryRun`. I checked it with throwaway scripts in `/tmp`; none are in the project, and there is no test file or npm script, so the checks can't be re-run from the repo. It uses no dependencies, so `package.json` is unchanged.

**What I checked**
- **Concurrency and restart:** 10 separate processes decided for one user at the same moment, and exactly 3 were delivered. Decisions made by those processes were all readable afterwards from a new process.
- **Quiet hours:** 21:59 is delivered, 22:00 is blocked, 07:59 is blocked, and 08:00 is delivered.
- **Consent:** a user without consent is blocked, and `availableAt` is null.
- **Daily cap:** a 4th notification at 21:00 UTC was blocked, with `availableAt` set to the next day 08:00. For a user in Pacific/Kiritimati (UTC+14), the cap counted by local day, not UTC day.
- **Daylight saving:** a block on the Europe/Berlin spring-forward night reports `availableAt` as 08:00 CEST (`2026-03-29T06:00:00.000Z`).
- **`whyNotReceived` range:** `from` is included and `to` is excluded.
- **`dryRun`:** it returned the expected counts for two policies. The real decision records for the same user were identical before and after.

**Behaviors to know**
- **State:** each user has an append-only log file in `STATE_DIR`, guarded by a lock so concurrent workers are safe. A lock held for more than 10 seconds is treated as stale and taken over.
- **Rule codes:** `NO_CONSENT`, `QUIET_HOURS`, `DAILY_CAP`, and `BAD_TIMEZONE` for a missing or invalid timezone. A bad timezone is blocked.
- **Rule order:** consent is checked first, then quiet hours, then the cap. Only delivered notifications count toward the cap.
- **Repeated notification id:** calling `decide` again for the same user and notification id returns the first answer and counts nothing twice. This protects against retries, but a notification blocked at 03:00 stays blocked if it is retried at 09:00. Say if you want blocked ones re-evaluated instead.
- **`availableAt`:** it accounts for the cap on the day it falls in. A quiet-hours block after the cap is full gives the next day's 08:00.
- **`dryRun`:** it applies the same repeated-id rule as `decide` and uses each event's own `consent` value. It orders events by time, and `quietHours: null` or `dailyCap: null` turns that rule off.
- **`text`:** it is built in English from the user's local time, for example "…because the daily limit of 3 notifications had already been reached for that day. It could have been delivered from 2026-03-11 08:00 (Europe/Istanbul)."
