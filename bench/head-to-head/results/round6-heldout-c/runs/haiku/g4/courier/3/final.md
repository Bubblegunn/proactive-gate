I wrote `bot.mjs` in the work directory and it passes my checks. It is untracked and not committed.

**How it works**
- **Limit:** a send is allowed only if fewer than 5 proactive messages to that customer fall in the last 24 hours, counting sms, push and chat together. The window is sliding, so a message sent at time T stops counting at exactly T+24h.
- **Concurrency:** each customer has a lock directory created with `mkdir`, which is atomic across processes. The check and the write happen while the lock is held. A lock older than 10 seconds is treated as left behind by a crash and removed.
- **Persistence:** each customer's send history is one JSON file under `STATE_DIR/users/`, named by the SHA-256 of the user ID. Writes go to a temp file, are fsynced, then renamed into place. `STATE_DIR` and its subdirectories are created if missing.
- **Blocked calls:** `retryAt` is the instant the oldest message needed to free a slot leaves the window (that message's time plus 24h). Nothing is recorded for a blocked call.
- **Reason:** a blocked reason names the 5-per-24h limit across all channels. An allowed reason shows how many of the 5 are now used.

**Choices I made that you may want to change**
- Invalid `userId`, `channel` or `now` throws a `TypeError`. An unset `STATE_DIR` also throws.
- A corrupt state file makes `reserve` throw rather than undercount. The worker then sends nothing for that customer until someone fixes the file.
- Messages dated after the caller's `now` (from a worker whose clock is ahead) still count, which is the conservative choice.
- History is pruned after 48 hours, which is safe even if a caller passes a slightly older `now`.

**Verification**
A test script in `/tmp/bot-test` (outside the work directory) passes all checks:
- 5 allowed, then blocked with the exact `retryAt`.
- Blocked at `retryAt`-1ms, allowed at `retryAt`.
- Mixed channels count together.
- Customers are independent.
- A sliding window with a retry time that moves as old sends expire.
- 30 parallel in-process calls allow exactly 5.
- 8 separate Node processes making 32 calls in total allow exactly 5.
- A new process after a "restart" sees the existing count.
- A stale lock left behind is recovered.
- Invalid inputs throw.

**Limits**
- Only safe on one host with a local filesystem. `mkdir` locking is not reliable on NFS, and you said all workers run on one server.
- The stale-lock break has a very small race if two processes break the same stale lock at the same instant. The lock is held for a few milliseconds, so I judged this acceptable, but it is not impossible.
