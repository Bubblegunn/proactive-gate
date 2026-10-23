`bot.mjs` is written. In my tests no customer got more than 2 marketing messages in a local day, with several processes and several calls per process running at once.

**How it works**
- **Slot files:** each customer has a directory under `STATE_DIR/slots/`. An allowed message creates the file `<local-date>.<n>`, with n = 1 or 2, using exclusive-create, which only one process can win. If both slots are already taken, the call returns `{ allowed: false, rule: "daily-cap" }`.
- **No lock:** nothing needs releasing, so a worker that crashes mid-call can't leave a stale lock that blocks everyone else.
- **Restarts:** the slot file is synced to disk before `reserve` returns, so the count survives a restart of every process.
- **Local day:** it comes from `now` and `timeZone` using `Intl`, so the clock is never read. All channels share the same 2 slots.
- **Log:** every call appends one JSON line to `STATE_DIR/decisions.log`. Each line has the user, channel, local day, `allowed`, `rule`, slot number and pid, so you can see which message was held and why.
- **Bad input:** an invalid `channel`, `now`, `timeZone` or `userId`, or a missing `STATE_DIR`, throws instead of returning an answer. In that case don't send.

**What I tested**
- **Concurrent workers:** 6 Node processes, each making 5 simultaneous calls for the same customer in Asia/Tokyo, produced exactly 2 `allowed: true` out of 30.
- **Midnight boundary:** a call at 15:00Z, which is midnight in Tokyo, got 2 new slots.
- **Restart:** a fresh process later on the same Tokyo day was held with `daily-cap`.
- **Other customer and zone:** a different customer in America/Los_Angeles on the day the clocks change got 2 slots.
- **Log:** `decisions.log` had 45 lines for 45 calls.

**Limits**
- A slot is used up when `reserve` allows the message. If the worker crashes before it sends, that slot stays used. This errs toward sending too few messages, not too many.
- If a customer's `timeZone` changes during a day, the day is worked out separately for each zone.
- The slot and log files are never cleaned up. Old `<date>.<n>` files can be deleted safely once their day has passed everywhere.
