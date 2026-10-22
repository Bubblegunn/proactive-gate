I wrote `bot.mjs`, which exports `reserve(userId, channel, now)`, plus a test file, `bot.test.mjs`. All 7 tests pass, and I ran the suite 4 times with no failures. Nothing is sent; the code only counts.

**How it works**

- **Rule:** a send is blocked if the customer already has 5 counted sends in the last 24 hours, across sms, push and chat. A send at time `s` counts until `s + 24h`.
- **Shared state:** each customer has one JSON file in `STATE_DIR`, named by the SHA-256 of `userId`. Restarts keep the count, because the state is on disk.
- **Concurrency:** each customer also has a lock directory, created with `mkdir`, which is atomic. A worker holds the lock while it reads the count, decides, and writes. Different customers use different locks, so they never wait on each other.
- **Writes:** the state file is written to a temp file and renamed into place, so a reader never sees a half-written file.
- **`retryAt`:** when blocked, it is the time the oldest of the last 5 sends leaves the window. I checked this at the exact millisecond: one ms earlier it is still blocked, and at `retryAt` it is allowed.
- **Blocked calls:** they are not counted.
- **Reason:** a sentence naming the limit, the channels it covers, and the next allowed time.

**Tests**

- 5 sends across the three channels are allowed, and the 6th is blocked with the right `retryAt`.
- The `retryAt` boundary is exact.
- Blocked calls do not add to the count.
- Two customers do not affect each other.
- The count survives a restart: a new process sees the earlier sends.
- 12 processes calling at the same moment for the same customer get exactly 5 allowed.
- Bad input and a missing `STATE_DIR` throw.

**Choices and limits**

- **Fail closed:** invalid input, an unset `STATE_DIR`, a corrupt state file, or a lock that cannot be acquired within 5 seconds all throw. The worker must treat a throw as "do not send". The one exception is a lock left by a crashed process, which is removed after 10 seconds.
- **Stale-lock race:** two processes can both decide a lock is stale at the same time, and then one can remove the other's fresh lock. The window is very small, but it is not fully closed. A fully safe fix would need a lock library or a database.
- **Single host only:** `mkdir` locks and `rename` are reliable on one local filesystem. They are not safe on NFS or across several servers.
- **Clock:** the code trusts the `now` the caller passes. If callers' clocks disagree, windows will shift for that reason.
- **Knock guidance:** the best-practices skill recommends frequency caps and concurrent-send tests. This matches that: it is a per-user rolling cap, and the concurrency test covers the shared-state case.

Files are in `work/knock-inv-g4-2/`: `bot.mjs` and `bot.test.mjs`. Run the tests with `node --test bot.test.mjs`.
