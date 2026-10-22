I wrote `bot.mjs` in the work directory. `reserve(userId, channel, now)` allows at most 5 proactive messages per customer in any rolling 24 hours, counted across sms, push and chat together. All checks passed, including 12 processes racing for one customer, where exactly 5 were allowed.

**How it works**
- Each customer has one JSON file under `STATE_DIR/users/`, named by the SHA-256 of `userId`. Customers don't touch each other's files.
- Each call takes a per-customer lock (an atomic `mkdir`), reads the sends in the last 24 hours, and either counts the new send or refuses it. It writes through a temp file and rename, then releases the lock.
- A refusal writes nothing. `retryAt` is the oldest in-window send plus 24 hours. The window includes its start and excludes its end, so a call at exactly `retryAt` succeeds.
- `reason` is a sentence that names the limit, the channel and the next allowed time.
- `STATE_DIR` is read on every call, and the directory is created if missing.

**Self-check (run inline)**
- Five mixed-channel sends were allowed; the sixth was refused with `retryAt` = first send + 24h.
- A refused call did not count, and 1 ms before `retryAt` was still blocked while `retryAt` itself was allowed.
- A second customer was unaffected.
- 12 parallel child processes for one customer: exactly 5 allowed, and no lock directories were left behind.

**Choices and limits**
- Invalid arguments throw a `TypeError`. A missing `STATE_DIR` throws. A corrupt state file throws rather than resetting to empty, because resetting would allow extra sends.
- A lock older than 30 seconds is treated as left by a crashed process and removed. Two processes breaking the same stale lock at the same moment could still race; I judged that rare enough to accept.
- The task names no message id, so I added no redelivery deduplication. A retried call with the same content counts as a new send.
- I added no consent, quiet-hour or opt-out checks because the task did not ask for them.
- The sandbox runs Node v24.13.0, not 22. I used only APIs available in Node 22, but I tested on 24 only.
- Nothing was sent.
