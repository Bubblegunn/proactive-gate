`bot.mjs` is written and passes the checks I ran. It exports `reserve({ userId, timeZone, channel, now })` and sends nothing.

**How it works**
- **Day and cap:** it takes the customer's local calendar day from `now` and `timeZone`, then counts the sends already recorded for that day across sms, email and push. If the count is 2 or more it returns `{ allowed: false, rule: "daily-cap" }`. Otherwise it records the send and returns `{ allowed: true, rule: "" }`. The `rule` string is the one place that says which rule held a message, so you can log it.
- **Sharing between workers:** each customer gets one JSON file in `STATE_DIR`, named by a hash of `userId`. The directory is created if it is missing. A lock directory per customer makes the read, count and write one step, so workers and concurrent calls inside one worker cannot both slip under the cap.
- **Restarts and crashes:** writes go to a temp file, are flushed to disk, then renamed into place, so a crash cannot leave a half-written file. A lock older than 30 seconds is treated as left by a dead process and taken over.
- **Pruning:** records older than 3 days are dropped.
- **Errors:** a bad `userId`, channel, `now` or `timeZone`, a missing `STATE_DIR`, or a corrupt state file throws. The worker should not send in that case.

**What I tested**
- **Concurrency:** 8 processes made 5 concurrent calls each (40 attempts) for one customer. Exactly 2 were allowed.
- **Restart:** a fresh process on the same day was held with `daily-cap`.
- **Day boundaries:** in Asia/Tokyo, a call at 00:00 local was allowed again. In America/Los_Angeles, on the day daylight saving starts, sends just before and after local midnight were counted on separate days, with the cap applied to the second day.
- **Stale lock:** a lock left behind more than 30 seconds earlier was taken over and the call succeeded.

**Limits**
- The locking assumes `STATE_DIR` is on a local file system. On NFS, `mkdir` may not be atomic.
- The daily count uses the time zone passed on each call. If a customer changes time zone mid-day, their earlier sends are counted in the new zone.
- I ran this on Node 24 here, not Node 22. It only uses `node:` built-ins, so I expect it to run on 22 as well.

The test scripts are in `/tmp/rt`, outside your repo.
