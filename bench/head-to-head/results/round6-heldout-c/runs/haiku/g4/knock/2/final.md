I wrote `bot.mjs` in the work directory. It exports `reserve(userId, channel, now)`, and all 15 of my tests pass on five repeated runs. The tests ran on Node v24.13, the only Node on this machine, not Node 22.

**How it works**
- Each customer has one JSON file in `STATE_DIR`, named by the SHA-256 of their `userId`. Each file holds the timestamps of that customer's counted sends, across all channels.
- A per-customer lock directory, created with `mkdir`, serializes the read-check-write step across processes. Different customers have different locks, so they never wait on each other.
- The window is sliding. A send at time `s` counts for a check at `t` while `s > t - 24h`.
- When allowed, the send is recorded before the function returns. When blocked, nothing is recorded. `retryAt` is the oldest in-window send plus 24 hours, which is the earliest instant a new call can succeed.
- `reason` says the limit applies across sms, push and chat, and gives the retry time in ISO format.
- Writes go to a temp file and are renamed into place. The directory is created recursively if it is missing.
- Bad arguments throw a `TypeError`. A corrupt state file throws rather than allowing the send, so the send fails closed.

**Tests** (outside the work directory, at `/tmp/bot-check/bot.test.mjs`)
- Exactly 5 sends are allowed and the 6th is blocked with the right `retryAt`.
- The limit is shared across channels.
- Denied calls are not counted.
- The window slides, and `retryAt` is exact to the millisecond.
- Customers are independent.
- State survives a fresh process.
- 40 concurrent calls in one process allow exactly 5.
- 12 concurrent processes making 3 calls each allow exactly 5, and leave no lock or temp files behind.
- A stale lock from a crashed process is broken.
- A corrupt state file throws, and missing `STATE_DIR` throws.

**Known limitation:** a lock is treated as stale after 10 seconds. If two processes both try to break the same crash-leftover lock at the same instant, one can remove the other's fresh lock. The window is very small, since a lock is held for milliseconds, but it is not zero. If that is unacceptable, the fix is a lock that the OS releases on process death, such as `flock` through a native module.

I did not commit anything, and I did not send any messages.
