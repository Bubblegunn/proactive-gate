`bot.mjs` is written and its 11 tests pass. I did not commit anything.

**Files** (in the working directory)
- `bot.mjs`: exports `reserve(userId, channel, now)`.
- `bot.test.mjs`: `node --test bot.test.mjs`.

**How it works**
- Each customer has one JSON file under `STATE_DIR/customers/`, named by the SHA-256 of the userId. It holds the timestamps and channels of messages already sent.
- Each `reserve` call takes a per-customer lock. The lock is a `mkdir` on `<hash>.lock`, which is atomic across processes. Other customers use different locks, so they never wait on or affect each other.
- Under the lock, the call prunes old entries, counts the messages in the last 24 hours on all channels, and allows the send if fewer than 5 remain. An allowed send is written before the call returns. The write is atomic: temp file, fsync, rename.
- When blocked, `retryAt` is the oldest in-window message's time plus 24 hours. The window is `(now − 24h, now]`, so a message is exactly 24 hours old when it stops counting. The tests check this to the millisecond.
- `reason` names the customer, the 5-message limit, the channel and the retry time.

**Choices you may want to change**
- **Fail closed.** Corrupt state, invalid input, or a lock that cannot be taken within 5 seconds makes `reserve` reject. A rejected call means the worker should not send.
- **Stale locks.** A lock older than 10 seconds is treated as left by a crashed process and removed. The critical section takes milliseconds.
- **Clock skew.** Entries are kept for one extra minute past the window, so a worker whose clock is up to a minute behind still counts every message it should.

**Verification**
- Concurrency test: 12 processes call `reserve` for the same customer at the same instant. Exactly 5 are allowed. A mixed run with three customers gives 5, 5 and 1.
- Control: with the lock disabled, the two concurrency tests fail. So the tests do detect the race.
- Restart: a new process sees the earlier state.

**Limits**
- Only Node 24 (v24.13.0) is installed here. I did not run the tests on Node 22, your target, though the code uses only built-in APIs that Node 22 has.
- Stale-lock recovery has a residual race. A rename-back in `removeIfStale` can race with a new lock, and the window is microseconds, reached only after a 10-second stale lock. I accepted that and documented it in the code.
