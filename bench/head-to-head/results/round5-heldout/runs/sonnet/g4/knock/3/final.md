I wrote `bot.mjs` and tested it, including 12 worker processes racing on one lead; all the checks passed. Nothing was sent.

**How it works**
- **Storage:** each lead has one JSON file in `STATE_DIR`. The directory is created if missing, and the history survives restarts and is shared by all workers.
- **Locking:** a per-lead lock (an atomic `mkdir`) makes check-and-claim one step, so simultaneous workers can't both take the last slot. Locks left behind by a crashed process are cleared after 15 seconds.
- **Reservation ids:** the id contains a hash of the lead, so `release()` can find the right file from any process.
- **Rolling window:** a slot counts for `windowHours` after it was reserved, not until a calendar-day reset. A lead is never over `maxPerWindow` in any span of that length.
- **Minimum gap:** measured from the latest active slot. A slot dated slightly ahead of `now` because of clock differences between workers also counts as too recent.
- **What counts:** only granted slots count. Denied attempts are not recorded, so retrying doesn't extend a lead's block. Released slots stop counting for both limits.
- **Release:** it returns `true` when it removes a slot and `false` for an unknown or already-released id, so a double release is harmless.
- **Reason codes:** `window_limit_reached`, `min_gap_not_elapsed`, and `invalid_request` for bad input. The window limit is checked first.
- **Unreadable history:** a corrupt state file throws instead of being treated as empty, so a damaged file can't let a burst through.

**What I tested**
- Gap denial, window denial, release then re-reserve, and the window rolling forward after 24 hours.
- 12 separate processes racing on one lead with a limit of 3: exactly 3 were allowed.

**Known limits**
- It uses the caller's `now` for all timing, so workers with very different clocks can affect each other.
- Removing a stale lock has a tiny race. It only matters if a holder crashed and several waiters collide at the 15-second mark.
