`bot.mjs` is written and passes its tests. Nothing was sent.

**Files** (in `work/courier-inv-g4-1/`, not committed)
- `bot.mjs`: exports `reserve(request, now)`, `release(reservationId)`, and `REASONS`. No dependencies.
- `bot.test.mjs`: 10 tests using `node:test`. The suite passed on 4 consecutive runs.

**How it works**
- **Shared state:** one JSON file per lead in `STATE_DIR/leads/`. A per-lead `mkdir` lock serializes each check-and-write across processes. A lock older than 10 s is treated as left by a crashed worker and broken.
- **What counts:** a reservation counts from the moment it is granted, even before the send finishes. A released reservation stops counting, because the lead never got the message.
- **Window:** rolling. A send counts for `windowHours` after it was made. A fixed calendar window would allow a burst across the boundary.
- **Reason codes:** `min_gap_not_elapsed` and `window_limit_reached`. If both apply, the gap code wins.
- **Release:** the reservation id embeds the lead's hash, so any process can release it. A second release returns `false` and changes nothing.
- **Clock skew:** gaps and windows use the absolute distance from `now` to each send, so a caller whose clock is slightly off cannot slip under a limit.
- **Retention:** entries older than 30 days are pruned, so `windowHours` is capped at 720.

**Verified**
- Gap, window cap, rolling expiry, per-call limits, release (idempotent), and release from a different process.
- A stale lock is broken.
- 12 processes started together on one lead:
  - With `maxPerWindow: 3` and no gap, exactly 3 were allowed.
  - With a 90-minute gap, exactly 1 was allowed.
- Invalid input throws `TypeError`.

**Notes**
- The Courier skill covers Courier's own sends, throttling, and journeys. None of that applies to a local limiter, so I did not use it beyond loading it.
- `STATE_DIR` is not set in this environment. The tests used temp directories, and I did not create your real one.
- The sandbox runs Node v24.13.0, not Node 22. The code uses only APIs available in Node 22, but I have not run it on Node 22 itself.
- Denied attempts still rewrite the lead file, to apply pruning. That is a small cost; say if you would rather they didn't write.
- Reservations that a worker crashes before sending or releasing still count until they age out of the window. This errs toward sending less.
