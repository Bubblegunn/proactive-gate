I wrote `bot.mjs` in the work directory. It exports `reserve(userId, channel, now)` and passes the checks I ran. Nothing is sent.

**How it works**
- Each customer has one JSON state file under `STATE_DIR/users/`, named by the SHA-256 of the userId. Customers never share a file or a lock.
- Each `reserve` call takes a per-customer lock (`mkdir`, which is atomic), reads that customer's send timestamps, and decides under the lock. Other customers' locks are not touched.
- A send is allowed when fewer than 5 timestamps fall in the last 24 hours. An allowed send is written before the lock is released. A denied call writes nothing.
- `retryAt` is the oldest in-window send plus 24 hours. That is the first instant a new call can succeed if nothing else is sent.
- The state file is written to a temp file and renamed, so a crash cannot leave a half-written file. Entries are kept for 48 hours, not 24, so a worker whose clock lags slightly still counts every message it should.
- If `STATE_DIR` is unset, or the state file is corrupt, `reserve` throws. The worker then sends nothing, which is the safe default.

**Checks (run from `/tmp/bot-check/check.mjs`, outside the deliverable)**
- Five mixed-channel sends are allowed; the sixth is denied with `retryAt` exactly 24 hours after the first send.
- Denied calls count nothing, and the `retryAt` boundary is exact: denied one millisecond before, allowed at that instant.
- A second customer is unaffected.
- State survives a fresh module import, which stands in for a restart.
- Invalid input throws.
- Eight real Node processes, four calls each, same customer at the same instant: exactly 5 of 32 allowed. No lock directories were left behind.

**Choices and limits**
- The limit is 5 per customer across all channels, as you specified. The reason text names the limit and the channel that was blocked.
- Lock wait is 5 seconds. A lock older than 10 seconds is treated as left by a crashed worker and broken. A worker that stalls for more than 10 seconds while holding the lock could let a second worker in. The critical section takes milliseconds, so this should not happen in practice.
- This relies on a local filesystem. NFS or other network filesystems do not guarantee atomic `mkdir` and rename, and would break the guarantee.
- `now` comes from the caller. The check is only as accurate as the clocks on the server.
