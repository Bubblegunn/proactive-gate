I wrote `bot.mjs`. It passed my tests, including 8 separate Node processes calling at the same moment. Nothing is actually sent.

**How it works**
- **State:** Each user has one JSON file in `STATE_DIR`, named by a SHA-256 hash of the user id. It holds the times of the marketing messages already reserved. The directory is created if it is missing.
- **Locking:** Each user also has a lock file, created with exclusive-create. It covers the whole read, count, check, write cycle. That is what stops a fourth message, both between workers and between concurrent calls inside one worker.
- **Crashes:** Writes go to a temp file, are synced to disk, then renamed into place, so a crash never leaves a half-written file. If a worker dies while holding a lock, the lock counts as stale after 15 seconds and the next caller removes it.
- **Counting:** The count is across all channels. A message counts for "today" if it falls on the same calendar date in the `timeZone` passed to that call. Only `now` is used for time, never the system clock. DST days of 23 or 25 hours work, because dates are compared rather than 24-hour windows. Entries older than 3 days are dropped.
- **Return values:**
  - Allowed: `{ allowed: true, rule: "" }`, and the message is stored before returning.
  - Held by the cap: `{ allowed: false, rule: "daily-cap" }`. This is the rule your logs were missing.
  - Bad input (unknown time zone, bad channel, empty user id, invalid `now`): `{ allowed: false, rule: "invalid-request" }`.
  - Lock wait over 30 seconds, or state file unreadable or corrupt: `{ allowed: false, rule: "state-unavailable" }`. A corrupt file is never reset, so an unreadable state can't silently lift the cap.
- **Config:** If `STATE_DIR` is not set, the call throws.

**What I tested** (`/tmp/t8/t.mjs`)
- 8 processes × 10 concurrent calls for one user gave exactly 2 allowed, and every block reported `daily-cap`.
- A new process in the same Tokyo day was blocked at 23:59 local time and allowed again at local midnight.
- New York around the DST change on 2026-11-01 behaved correctly, including the 25-hour day.
- A stale lock from a dead process was cleared, different users did not affect each other, and 1000 concurrent calls across 200 users in one process all got the right answer.
- No lock or temp files were left behind.

**Limits**
- A worker that crashes after `reserve` returns `allowed: true` but before it sends has still used up one of that customer's two messages. I chose this because it errs on the side of sending too few.
- Stale-lock removal relies on the 15-second timeout. It would only misfire if a live worker froze for longer than that while holding a lock.
- The shared directory must be a local filesystem or one with working exclusive-create and rename. Some network filesystems, such as old NFS, are unreliable for that.
