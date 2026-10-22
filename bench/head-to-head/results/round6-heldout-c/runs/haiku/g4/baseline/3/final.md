bot.mjs is written at `work/baseline-g4-3/bot.mjs`. All checks pass, including a race test with 12 processes. Nothing is committed.

**How it works**
- Each customer gets one JSON file in `STATE_DIR/users/` (named by SHA-256 of userId) holding the timestamps and channels of counted sends. Customers never share files or locks.
- A `mkdir`-based lock per customer makes the read-check-write step atomic across processes. The state file is replaced with write-to-temp plus rename, so a crash can't leave a partial file.
- The window is sliding: a send counts while it is less than 24 hours old. Channel is not part of the count, so sms, push and chat share the 5.
- When blocked, `retryAt` is the 24-hour mark of the oldest entry that has to age out for a send to fit. Only that entry matters, because the count needs to drop from 5 to 4.
- The reason string names the limit and gives the retry time, for support staff.
- Invalid input throws, and a missing `STATE_DIR` throws. A corrupt state file makes `reserve` throw rather than allow the send.

**Checks** (scratch script in `/tmp/bot-test`, outside the work directory)
- Five mixed-channel sends are allowed and the sixth is blocked with the correct `retryAt`.
- One millisecond before `retryAt` is blocked; at `retryAt` it is allowed.
- A different customer is unaffected.
- A separate Node process sees the state written by an earlier one.
- A race of 12 processes × 3 attempts for one customer allowed exactly 5 in each of 3 rounds.
- Invalid arguments and a missing `STATE_DIR` are rejected.

**Limitations**
- Locks are only safe between processes on one machine. `mkdir` locks are not reliable on NFS or other network filesystems. Your setup is one server, so this should not matter.
- A lock left by a crashed process is broken after 30 seconds. If a holder stalled for longer than that while still running, two sends could slip through. The critical section takes milliseconds, so this is unlikely.
- The limiter trusts the `now` each worker passes in. If the workers' clocks disagree, the window will be inaccurate. Using one clock source (the server's clock) avoids this.
- I tested on Node 24 (the local version). The code uses only APIs that exist in Node 22.
