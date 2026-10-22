Wrote `bot.mjs` in the work directory. All checks pass, and nothing is sent.

**How it works**
- Each customer gets one JSON file in `STATE_DIR/users/`, named by the SHA-256 of their `userId`. The file holds the timestamps of that customer's recent sends, across all channels.
- Before counting, `reserve` takes a per-customer lock (`STATE_DIR/locks/`, created with `mkdir`, which is atomic). Different customers use different locks, so they never wait on each other. Under the lock it drops timestamps older than 24 hours, then either records the send (fewer than 5 in the window) or refuses.
- The file is written to a temp name and renamed into place, so a crash cannot leave a half-written file.
- `retryAt` is the oldest in-window send plus 24 hours. A send at `t` counts while `now < t + 24h`, so `retryAt` is the first instant `reserve` would succeed. A refused call records nothing.
- `reason` is one sentence that names the limit, the channel that was refused, and the `retryAt` time.

**Choices I made that you may want to change**
- A corrupt state file throws rather than being treated as empty. Treating it as empty would silently reset the limit for that customer.
- A lock older than 10 seconds is treated as left behind by a crashed process and removed. This has a tiny race: if two processes both find the same stale lock, one could remove the other's fresh lock. That needs a crash plus a near-simultaneous takeover, but it is possible.
- Invalid input throws a `TypeError`: a bad `userId`, an unknown channel, or an invalid `Date`. A missing `STATE_DIR` also throws.
- Per-customer files are never deleted, so the directory grows by one small file per customer ever contacted.
- The caller's `now` is trusted. If worker hosts have clock skew, the window is measured with the skewed clocks.

**Testing**
I ran the tests from `/tmp/bot-test/test.mjs`, outside the work directory. They pass and cover:
- Five sends allowed across mixed channels, then a refusal with the correct `retryAt`.
- Refused calls record nothing.
- `retryAt` is exact: one millisecond earlier is refused, at `retryAt` it is allowed.
- Other customers are unaffected.
- A separate Node process sees the state written by an earlier one.
- Eight processes each making 15 calls for one customer at the same instant produce exactly 5 allowed in total.
- A stale lock is recovered.
- Invalid input is rejected.

The first run failed on an error in my test's expiry timing, not in the bot. I corrected the test and reran it; the bot code was unchanged.
