`bot.mjs` is written, and in my tests no customer got more than 2 messages in a local day. I tested it with 8 separate Node processes making 5 concurrent calls each. I did not send anything.

**How it works**
- Each user has one log file in `STATE_DIR`, named by a hash of the `userId`. Every call appends one attempt line to that file and then re-reads the file.
- Attempts are judged in the order they sit in the file, which every worker sees the same way. An attempt is allowed only if fewer than 2 earlier allowed attempts fall on the same local day in that attempt's time zone. The day is worked out with `Intl` from the `now` you pass in, so the system clock is never read.
- If a call is stopped, it returns `{ allowed: false, rule: "daily-cap" }`. When allowed, `rule` is `""`.
- There are no lock files, so a crashed worker cannot leave a lock behind. The state is on disk, so it survives restarts of every process. A half-written line from a crash is skipped.
- If a worker records an allowed attempt and dies before sending, that attempt still counts. The failure mode is a missed message, never a third one.
- Denied attempts are also written to the log, with the user, channel, time and time zone. That is what lets you see which message was held.

**What I checked**
- **Concurrency:** 8 processes made 40 concurrent calls for one user, and exactly 2 were allowed.
- **Restart:** fresh processes right afterwards were all denied.
- **Day boundary:** in Asia/Tokyo, 14:59Z (still the old day) counted against the old day, and 15:00Z started a new day with 2 allowed again. In Los Angeles, 06:59Z and 07:00Z fell on different local days.
- **Bad input:** an invalid time zone throws a `RangeError`.

**Limits**
- `reserve` throws a `TypeError` for a bad `userId`, `channel` or `now`, and an `Error` if `STATE_DIR` is not set. Catch these in the worker, and decide whether it sends or holds the message when that happens.
- The shared log files must be on a local disk, or on a network filesystem that handles appends correctly. Check that if `STATE_DIR` is on NFS.
- The log files only grow. I did not add cleanup.

I loaded the Courier skill as you asked, but nothing here calls Courier. This is a local check that runs before the send.
