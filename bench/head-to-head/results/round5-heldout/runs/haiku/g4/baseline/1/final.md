Wrote `bot.mjs` in the work directory. Tests pass, including a 12-process race on one lead that allowed exactly 3 of 12. Nothing was sent, and I did not commit.

**What counts and how the window moves**
- A reservation counts from the moment it is allowed until it is released. Denied requests never count.
- **Min gap:** a new send is refused if any counted send is within `minGapMinutes` of it, before or after. A recipient feels the distance to the nearest message, and this also covers out-of-order caller clocks.
- **Max per window:** a sliding window. No span of `windowHours` that contains the new send may hold more than `maxPerWindow` sends. Fixed daily buckets would let a lead get twice the limit across a bucket edge.
- **Reason codes:** `min_gap_not_elapsed` and `max_per_window_exceeded`.

**Shared state**
- History is in `STATE_DIR/leads/<sha256(userId)>.json`, written via temp file, fsync, and rename. A corrupt file throws instead of being treated as empty.
- A per-lead `mkdir` lock serializes writers across processes. A lock older than 10 seconds is treated as left by a crashed holder.
- `reserveId` is `<leadKey>.<uuid>`, so `release` finds the right file without scanning. It works from any process. Releasing an unknown or already-released id returns `false` and does nothing.
- `STATE_DIR` is read on each call. The directory is created if missing.

**Known limits**
- A reservation whose worker crashes before sending or releasing stays counted. That errs toward under-sending, which protects the sender reputation.
- Old history is pruned only past the longest window or gap seen for that lead. A later call with a longer window can undercount history older than that earlier maximum.
- The lock's stale timeout is a heuristic. A holder that stalls past 10 seconds could in theory overlap with a new one.
- I ran it on Node 24 here, not Node 22. It uses only long-stable APIs, but I did not run it on Node 22.

The test harness is in `/tmp/h2h-limiter-test/` and is not part of the repo. It covers the gap and window rules, the sliding edge, release semantics, per-call limits, per-lead isolation, out-of-order clocks, restart persistence, the race, and invalid input.
