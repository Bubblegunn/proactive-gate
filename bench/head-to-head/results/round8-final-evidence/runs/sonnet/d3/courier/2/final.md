`bot.mjs` is written in the working directory. I tested it with real concurrent processes, and it enforced the 2-per-day cap every time. Nothing was sent.

**How it works**
- **Shared state:** each user gets one JSON file in `STATE_DIR/users/`. It holds the timestamp and channel of every reserved message. The file name is a hash of `userId`.
- **Locking across workers:** a per-user lock directory in `STATE_DIR/locks/` is created with `mkdir`, which only one process can succeed at. Inside the lock the function reads the file, counts today's messages, and writes the new one if allowed. The write goes to a temp file, is fsynced, and is then renamed over the old file, so a crash cannot leave a half-written file. Concurrent calls inside one worker queue up per user.
- **Crashes:** a lock older than 15 seconds is treated as left by a dead worker and is removed. Because state is only files, it survives restarts of every process.
- **The day:** midnight to midnight in the `timeZone` passed to that call, computed from `now` with `Intl`. Earlier messages are re-counted in that same zone, so a customer who changes zone doesn't get extra messages. Entries older than 3 days are pruned.
- **Why a message was held:** a blocked call returns `{ allowed: false, rule: 'daily-cap' }`. You can log that to see which message was held.
- **Bad input:** these return `allowed: false` with a rule instead of throwing, so the worker doesn't send:
  - `invalid-user`
  - `invalid-channel`
  - `invalid-time`
  - `invalid-time-zone`

  A missing `STATE_DIR` or a corrupt state file throws.

**Test results**
- 6 processes making 5 simultaneous calls each (30 calls) for one user gave exactly 2 allowed, across all three channels. No lock directories were left behind.
- A fresh process on the same day, after the cap was reached, was refused. The cap persisted across restarts.
- In Asia/Tokyo, 14:59:59Z was still blocked, and 15:00:00Z (local midnight) allowed 2 more.
- In America/New_York on the DST change day (2026-03-08), the day boundary was correct and 2 were allowed on each side.
- An invalid zone name was refused.

**Limitation:** removing a stale lock can in theory race with another worker that has just taken a fresh lock. That needs a lock to be abandoned and two workers to notice at the same moment. The lock is held for only a few milliseconds, so I left it.

My test scripts are in `/tmp/t`, outside the project.
