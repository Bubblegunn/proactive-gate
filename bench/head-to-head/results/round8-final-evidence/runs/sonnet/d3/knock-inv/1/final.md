`bot.mjs` is written and tested. A customer now gets at most 2 marketing messages per local day, across all channels and all workers.

**How it works**
- Each allowed message creates one small file in `STATE_DIR`, named for the customer and local day: `STATE_DIR/<hash of userId>/<YYYY-MM-DD>.<1|2>`. The file is created with the exclusive flag, so only one process can ever create a given slot.
- A call tries slot 1, then slot 2. If both exist, it returns `{ allowed: false, rule: "daily-cap" }`. Otherwise it returns `{ allowed: true, rule: "" }`.
- There are no locks, so a crashed or restarted worker cannot leave anything stuck. The slot files are the only shared state.
- The local day comes from `now` and `timeZone` through `Intl`, and the code never reads the system clock. DST days are handled because the day is taken from the calendar date, not from 24-hour arithmetic.
- Each slot file also records the channel and time of the message that used it, which helps when you read the logs.
- The function throws on an invalid `userId`, `channel`, `now`, `timeZone` or a missing `STATE_DIR`. It does not return `allowed: false` for those, so bad input is not mistaken for a held message.

**What I tested**
- 6 separate Node processes, each making 3 concurrent calls for one customer (18 calls at the same moment) allowed exactly 2.
- A new process started afterwards still saw the cap.
- At 00:00 Asia/Tokyo, a new day started and 2 more messages were allowed.
- For America/New_York, 03:59Z and 04:00Z fell on different local days.
- On the New York DST day (2026-03-08), 05:00Z and 03:59Z the next day counted as the same day.
- An invalid time zone throws a `RangeError`.

I ran these under Node 24.13 here, not Node 22, but the code uses only standard `node:fs/promises`, `node:crypto` and `Intl` features.

**Limits**
- Slots are never deleted, so the state directory grows by up to 2 small files per customer per day. You can safely delete files for past days with a cleanup job.
- If a worker dies right after `reserve` returns and before it sends, that slot stays used. I chose that over risking a third message.
- `STATE_DIR` must be a local disk or a file system with working exclusive-create. NFS setups that lack it could break the guarantee.

I did not write a commit, and `bot.mjs` is unstaged.
