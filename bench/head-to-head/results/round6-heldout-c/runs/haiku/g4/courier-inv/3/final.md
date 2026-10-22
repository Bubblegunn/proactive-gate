`bot.mjs` is written in the work directory and passes my checks, including 8 processes racing on the same customer.

I loaded the courier skill as you asked, but it covers the Courier notification service. This task is a local limiter with no Courier calls, so nothing in the skill applied. Nothing was sent.

**How it works**
- Each customer has one JSON file in `STATE_DIR`, named by the SHA-256 of the user id. It holds the send timestamps and channels.
- Each call takes a per-customer lock (`mkdir`, which is atomic), reads the sends from the last 24 hours, and decides. Writes go to a temp file, are flushed, then renamed into place. Other customers have their own lock and file.
- Fewer than 5 recent sends: allowed, counted, `retryAt: null`. Five or more: blocked, nothing counted, `retryAt` = the 5th-newest send + 24h. The reason names the limit, that it covers all channels, and the retry time.

**Checks** (in `/tmp/bot-check/test.mjs`, outside the work dir)
- 5 mixed-channel sends allowed, the 6th blocked, `retryAt` correct.
- A blocked call counts nothing. Other customers are unaffected.
- Blocked 1 ms before `retryAt`, allowed exactly at it.
- Bad input throws. A stale lock from a crashed process is broken.
- 8 real processes × 10 calls on one customer at the same instant: exactly 5 allowed.
- A new process sees the earlier sends after a restart.

**Choices you may want to change**
- Invalid `userId`, `channel` or `now` throws. A timeout waiting for the lock, or a corrupt state file, also throws. The worker must treat a throw as "do not send".
- Locks older than 5 s count as stale and are removed. Locks are normally held for milliseconds.
- Each stored send also keeps its channel, so support can see it.

**Not verified**
- I ran the tests on Node v24.13.0. I did not run them on Node 22, which you named as the target.
- `STATE_DIR` must be a local disk that all processes share. I did not test network filesystems, where `mkdir` and `rename` may not behave the same.
- Stale-lock removal has a tiny race if two processes break the same stale lock at once. Given the 5 s threshold, I judged it acceptable, but it is not zero.
