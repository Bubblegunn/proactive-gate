`bot.mjs` is written at `work/ours-g4-3/bot.mjs`. The multi-process check passed, and nothing was sent.

**What it does**
- Counts each customer's sends across sms, push and chat together, in a rolling 24-hour window. A send counts while its timestamp is strictly after `now - 24h`.
- The 6th call inside the window is refused with `allowed: false`, a readable `reason`, and `retryAt` set to the moment the oldest of the last five sends leaves the window. Refused calls are not counted.
- Allowed calls are counted before the function returns, with `retryAt: null`.
- Each customer has its own record and lock, keyed by a SHA-256 hash of `userId`. State lives in `STATE_DIR/records` and `STATE_DIR/locks`, and the directories are created when missing.
- Writes go to a temp file, are fsynced, then renamed. A per-customer lock directory, created with `mkdir`, serializes the read-count-write step across processes.

**Self-check results**
- 8 separate Node processes made 16 concurrent `reserve` calls for one customer. Exactly 5 were allowed, 11 were refused, and every refusal had `retryAt` = now + 24h.
- Another customer in the same run got 4 of 4 allowed, so customers do not affect each other.
- For a fresh customer: 5 sends allowed, the 6th refused with the correct `retryAt`. At `retryAt - 1ms` the send was still refused; at `retryAt` it was allowed.

**Choices I made**
- Invalid `userId`, `channel` or `now` throw a `TypeError`, rather than returning a refusal.
- A lock older than 10 seconds counts as abandoned by a crashed process and is removed. Lock retries wait 5–20 ms.
- A corrupt record throws instead of being reset, so the worker fails before sending.
- Records are pruned using the caller's `now`. A caller with a much earlier clock could drop entries that a later caller still needs.

**Gaps you should know about**
- There is no message id, so a retried call for the same message is counted again. The spec gives no id parameter.
- Nothing is released if the send fails after `reserve` returns allowed, because the spec says the message is counted immediately and gives no release call. A failed send still uses one of the five slots.
- The stale-lock removal has a small race: two processes can both decide a lock is stale, and one can remove the other's fresh lock. The window is very small, but it is not zero.

I did not commit anything.
