`bot.mjs` is written and tested. It stops a customer getting a third marketing message on the same local day, across processes and restarts.

**How it works**
- **State:** each customer gets one JSON file under `$STATE_DIR/marketing-cap/`, named by a hash of `userId`. It lists the messages already allowed, with their time and channel.
- **Locking:** a lock file next to that file makes each decision one step at a time across all workers. Calls inside one worker are also queued per customer. The new message is saved (written to a temp file, synced, then renamed) before `reserve` returns `allowed: true`.
- **Day rule:** it counts earlier messages that fall on the same calendar date as `now` in the customer's `timeZone`, whatever the channel. At 2 or more it returns `{ allowed: false, rule: "daily-cap" }`. Otherwise it returns `{ allowed: true, rule: "" }`.
- **Crashed workers:** if a worker dies while holding the lock, the next worker sees the dead process id and removes the lock.
- **Errors:** a bad `userId`, time zone, channel or `now` throws before anything is stored. A corrupt state file also throws, so the function won't allow a send it can't count.
- **Clock:** it never reads the clock for the cap, only your `now`. The one exception is a fallback that clears a lock whose owner never wrote its process id, which compares the lock file's age to the system clock.

**What I tested** (using the state directory `/tmp/bt/st`)
- Eight processes, each making five concurrent calls for one customer, allowed exactly 2 messages in total.
- With Tokyo as the time zone, a call at 23:59 local on the same day was held. A call at 00:00 local the next day was allowed again, with 2 more allowed.
- Counts survived restarts, because each test run was a fresh process. A second customer in Los Angeles got the same results, and their count was separate from the Tokyo customer's.
- A leftover lock from a dead process id was cleared and the call went through.

**Limits:**
- Dead-process detection assumes all workers run on the same machine. If they run on different hosts sharing a network drive, a crashed worker's lock would stay for the 30-second wait and then throw.
- A held message is not logged anywhere. The caller gets the `rule` and has to log it itself. I can add a decision log in `STATE_DIR` if you want one.
