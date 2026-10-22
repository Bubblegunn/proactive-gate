`bot.mjs` is written at `work/knock-g4-3/bot.mjs`. It exports `reserve(userId, channel, now)`. All my checks pass, including 3 repeated runs of a 30-process race for one customer, which allowed exactly 5 each time. I did not commit anything.

**How it works**
- The 5-per-24h limit counts sms, push and chat together. A send at time `t` counts for any `now` with `now - t < 24h`.
- State is one JSON file per customer under `STATE_DIR/users/`, named by the SHA-256 of the user id. Only the newest 5 send times are kept, which is enough to decide the limit exactly.
- Each customer has a lock directory created with `mkdir`, which is atomic. Customers use separate locks, so they never wait on each other.
- When the limit is hit, `retryAt` is the oldest of the 5 counted sends plus 24h. I checked that it is blocked 1 ms before that instant and allowed at it.
- Denied calls are not counted. Allowed calls are counted before the function returns.

**Choices you may want to change**
- It throws instead of resolving `{ allowed: false }` when the input is invalid, `STATE_DIR` is unset, the lock wait exceeds 5 s, or a state file is corrupt. Treating a corrupt file as empty would let the limit be bypassed, so the function fails closed and the worker must not send.
- A lock older than 5 s is treated as left by a crashed process and is removed. If a process stalls for more than 5 s while holding the lock, a second process can take over. This is a small residual risk, and I did not find a way to close it without a compare-and-swap primitive.
- The state is written with a temp file, `fsync` and rename. That protects against process restarts. It does not cover a power loss in every case.

**Tests**
- The test script is in `/tmp/bot-test/`, outside the repo, so the repo stays clean. It covers: the 6th send being blocked, exact `retryAt` boundaries, cross-channel counting, customer isolation, a separate process reading saved state, the 30-process race, stale-lock recovery, corrupt state, invalid inputs, and no leftover lock directories.
- I ran it on Node 24.13. The machine does not have Node 22, so I did not test on 22. The APIs used are standard in 22.
