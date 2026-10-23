`bot.mjs` is written and exports `reserve({ userId, timeZone, channel, now })`. I tested it across processes and it held the cap. I did not send anything. I used the Courier skill but didn't need its API, because this is a local gate that runs before any send.

**How it works**
- **Shared state:** each user gets one file in `STATE_DIR`, named by a hash of `userId`. It lists the time of every reserved message, whatever the channel. `STATE_DIR` is created if missing and read on every call.
- **Locking:** each user also gets a lock file, created exclusively, so workers and concurrent calls inside one worker take turns. A lock more than 10 seconds old is treated as left by a crashed process and removed.
- **The decision:** the function counts stored messages that fall on the same calendar date as `now` in the customer's `timeZone`, so the day runs midnight to midnight local time. At 2 or more it returns `{ allowed: false, rule: "daily-cap" }`. Otherwise it records the message and returns `{ allowed: true, rule: "" }`. It never reads the system clock.
- **Durability:** state is written to a temp file, flushed to disk, then renamed over the real file. It survives restarts of every process. Entries older than 7 days are dropped.
- **Bad input:** an invalid channel, time zone, `now` or `userId`, a missing `STATE_DIR`, or a corrupt state file makes `reserve` throw. A worker that doesn't catch the error sends nothing, which is the safe outcome for a cap.

**What I checked**
- **Concurrency:** 8 Node processes, each making 5 concurrent calls for the same user at the same instant, produced exactly 2 `allowed` results out of 40.
- **Time zones:** in `Asia/Tokyo`, calls at 23:00 and 23:30 local were allowed and 23:59 was held. A call at the next local midnight was allowed. An `America/Los_Angeles` call whose local date matched those earlier messages was held.
- **Restart:** a fresh process after the concurrency run still saw the 2 stored messages and held the next one.
- **Stale lock:** an old lock file left by a "dead" process was cleared and the call went through.

**Limits**
- If a call stalls for more than 10 seconds while holding the lock, another process could take the lock over. Each call holds it for milliseconds, so I judged this unlikely.
- Every worker must see the same directory on a filesystem where exclusive file creation and rename are atomic. That's true for local disks, but not guaranteed on some network filesystems.
- A reservation is recorded before the send. If the send then fails, that message still counts toward the day's 2.
- To see which message was held, log the `rule` that `reserve` returns next to the message ID. The state files hold only times and channels.
