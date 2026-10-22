`bot.mjs` is written in the working directory. I didn't send anything. The Courier skill covers Courier's send API, so none of it applied to a local limiter. I used it only to check that frequency caps weren't something Courier could do for you.

**Checks I ran:**
- **Concurrency:** 12 separate processes asked for the same lead at the same instant, with a limit of 3. Exactly 3 were allowed and 9 were refused with `window_limit_reached`.
- **Sequence:** the gap check, the release and the window all behaved as described below.
- **`STATE_DIR`:** the directory is created if it doesn't exist.
- **Not tested:** restarting a worker, and what happens when a worker dies while holding the lock.

**How it works:**
- **Shared history:** every worker uses one ledger file, `reservations.json`, in `STATE_DIR`. Changes are written atomically while holding an exclusive lock file, so restarts lose nothing and every worker sees the same history. A lock left behind by a crashed worker is broken after 15 seconds.
- **What counts:** only reservations that still stand. A refused request leaves no record, so it never extends a lead's wait.
- **Release:** `release(id)` deletes the reservation, so a message that never arrived uses up no quota and no gap. Releasing an unknown or already released id does nothing, so it is safe from any worker.
- **Window:** it rolls. A send counts for `windowHours` after its own time, so there is no midnight reset. Exactly 3 sends in 24 hours can't turn into a burst of 6 around a boundary.
- **Gap:** it is measured from the lead's most recent standing reservation. The gap check also treats a reservation made slightly ahead of this caller's clock as too close.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. If both limits apply, you get the window code, because it blocks for longer.
- **Limits:** they are read from each call, so different campaigns can use different values against the same history.

- **Corrupt ledger:** if the ledger file is corrupt, the call throws instead of allowing sends. I chose that to protect your sender reputation, but it means a bad file stops all sending until someone fixes it.
- **Bad input:** a bad `request` or `now` also throws.
- **Retention:** records older than 45 days are dropped.
