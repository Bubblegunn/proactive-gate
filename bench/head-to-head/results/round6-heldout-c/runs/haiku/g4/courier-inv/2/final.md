`bot.mjs` is written at the work directory root and passes my checks. The Courier skill didn't change the design: this gate makes no Courier calls, so nothing in the skill applied.

**How it works**
- **Limit:** a customer gets at most 5 allowed sends in any rolling 24 hours. Sends on all three channels count together.
- **State:** one JSON file per customer in `STATE_DIR/users/`, named by the SHA-256 of the user ID. Files are written to a temp file and renamed into place, so a crash or restart never leaves a half-written file.
- **Concurrency:** each customer has a lock directory in `STATE_DIR/locks/`. `mkdir` is atomic, so only one process at a time runs the read-check-write for a given customer. Different customers take different locks and don't wait on each other.
- **Return values:** allowed sends are counted before the function returns and get `retryAt: null`. Denied sends are not counted and get the earliest retry time. The `reason` text names the limit and the time of the next allowed send.
- **retryAt:** it is the 24-hour expiry of the send that must age out for a new one to fit. With ties, it stays correct.
- **Bad input:** a bad `userId`, `channel` or `now` throws a `TypeError`. A corrupt state file makes the call reject, so the worker does not send.

**Checks run** (in `/tmp/gate-test/test.mjs`, outside the deliverable)
- Five mixed-channel sends are allowed; the sixth is denied with the right `retryAt`, and the denial itself is not counted.
- Calling at `retryAt - 1ms` is denied; calling at `retryAt` is allowed.
- A different customer is unaffected.
- Ties at the window edge produce the correct `retryAt`.
- State survives a fresh Node process.
- 12 separate processes racing for one customer at the same instant: exactly 5 allowed.
- 40 concurrent in-process calls: exactly 5 allowed.
- A stale lock left by a dead process is recovered.

My first run failed on a wrong expectation in my own test. I fixed the test and did not change `bot.mjs`.

**Limits and choices to check**
- It only coordinates processes on one machine's local filesystem. If `STATE_DIR` is on NFS or another network share, `mkdir` atomicity is weaker and the lock needs a different design.
- A lock older than 10 seconds is treated as left by a dead process and removed. The critical section takes milliseconds, so this should be safe, but a process stalled for more than 10 seconds could in theory allow one extra send.
- Entries stamped later than the caller's `now` still count, so clock skew between workers errs toward blocking.
- I did not commit anything.
