`bot.mjs` is written and exports `reserve({ userId, timeZone, channel, now })`. It allows at most 2 marketing messages per customer per local day, across all channels. I tested it with several Node processes; the checks and results are below.

**How it works**
- **State:** each customer has one JSON file in `$STATE_DIR/users/`, named by a hash of `userId`. It stores the send timestamps and channels, so state survives restarts.
- **Day counting:** the function counts sends that fall on `now`'s calendar day in the given `timeZone`, using `Intl`. It does not read the system clock. Because it stores timestamps rather than a day counter, daylight-saving changes and a customer changing time zone do not corrupt the count.
- **Concurrency:** every check-and-record runs under a per-customer lock directory, which `mkdir` creates atomically. Calls inside one worker queue up in memory first. The state file is replaced atomically, so a crash leaves either the old or the new state.
- **Crashed workers:** a lock is treated as abandoned if its owner process is dead or it is more than 30 seconds old. A single serialized step removes abandoned locks.
- **Denied messages:** a denied call returns `{ allowed: false, rule: "daily-cap" }` and records nothing. An allowed call returns `rule: ""`. Logging the returned `rule` in the worker will show which message was held and why.
- **Errors:** an invalid `timeZone`, an unknown `channel`, an invalid `now`, a missing `STATE_DIR`, a corrupt state file, or a lock wait over 30 seconds makes `reserve` throw. It does not return `allowed: true`. Workers must treat a throw as "do not send".

**What I tested** (real separate processes, temp `STATE_DIR`)
- 8 processes making 10 simultaneous calls each for the same customer produced exactly 2 `allowed: true`.
- Asia/Tokyo: a call at 23:59 local time was blocked, and a call at 00:00 the next day was allowed again (2 of 3 simultaneous calls).
- America/Los_Angeles: sends at 23:59 and 00:01 across midnight, then a third send the same morning, were all allowed.
- Each call in the Tokyo and Los Angeles checks ran in a fresh process, which confirms state persists across restarts.
- A leftover lock from a dead process was cleared, and the next three calls gave allow, allow, deny.

I did not test a lock that is stale only by age (30 seconds or more) with its owner process still alive. History older than 7 days is dropped on write.
