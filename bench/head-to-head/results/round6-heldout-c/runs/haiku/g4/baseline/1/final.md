`bot.mjs` is written and `reserve` works. All 11 tests pass, and the suite passed five more runs in a row. Nothing was sent, and I did not commit.

**Files** (in `work/baseline-g4-1/`)
- `bot.mjs`: exports only `reserve(userId, channel, now)`.
- `bot.test.mjs`: tests run with `node --test bot.test.mjs`.

**How it works**
- Each customer has one JSON file in `STATE_DIR`, named by the SHA-256 of the `userId`. It holds the timestamps of allowed sends.
- Every call takes a per-customer lock (`mkdir` on a `.lock` directory), so processes handling the same customer serialise. Different customers never wait on each other.
- The window is a rolling 24 hours: a send counts while `now - sentAt < 24h`.
- Allowed sends are added before the call returns. Denied calls add nothing.
- When blocked, `retryAt` is the expiry of the send that must leave the window first, so that is the earliest moment a retry can succeed.
- Writes go to a temp file and are then renamed, so a crash cannot leave a half-written state file.

**Tested**
- Exactly 5 allowed, the 6th blocked, and `retryAt` is the first send plus 24 hours.
- Blocked 1 ms before `retryAt`, allowed exactly at it.
- Denied calls don't extend the block.
- `sms`, `push` and `chat` share one limit.
- The window slides: old sends stop counting one by one.
- Customers are independent.
- State survives a restart: a separate process sees the earlier sends.
- 12 processes making 36 concurrent calls for one customer allow exactly 5.
- No `.lock` or `.tmp` files are left behind.
- Bad input is rejected, and a missing `STATE_DIR` is an error.

**Decisions to review**
- **Invalid input throws** (bad `userId`, unknown channel, bad `Date`). It does not return `allowed: false`.
- **Corrupt state file throws** rather than guessing a count, so the worker fails closed and sends nothing.
- **Stale locks** are broken after 10 seconds. This recovers from a crashed process. Two processes breaking the same stale lock at the same instant could in theory both proceed. Closing that fully needs `flock`, which Node does not provide.
- **Clock skew:** the window uses the `now` each caller passes in. If worker clocks drift, the limit can be off by the drift.
- **Node version:** this machine runs Node 24.13, not Node 22. I only used APIs that exist in Node 22, but I did not run the tests on Node 22.
