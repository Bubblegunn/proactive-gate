`bot.mjs` is written and its 13 tests pass, including 12 parallel processes racing for one lead's budget. Nothing was sent.

The courier skill covers the Courier notification API, which this task doesn't use. I built the limiter directly.

**Files** (in the work directory)
- `bot.mjs`: exports `reserve(request, now)` and `release(reservationId)`. No dependencies.
- `bot.test.mjs`: `node --test bot.test.mjs`.

**Choices I made**
- **Cross-process safety:** one JSON file per lead under `STATE_DIR/leads/`. Each read-modify-write holds a lock taken with `mkdir`, which is atomic across processes. Writes go to a temp file and are renamed into place.
- **What counts:** every allowed reservation counts from the moment it is granted, including ones not yet sent. Concurrent workers therefore cannot exceed the cap between them. A release removes the reservation from the history.
- **Window:** sliding. A send stops counting exactly `windowHours` after it was granted. This matches what the recipient experiences.
- **Gap:** measured from the most recent live send.
- **Channels:** counted per `userId`, not per channel. A lead reached on both WhatsApp and SMS shares one budget, since that is what the lead experiences.
- **Reason codes:** `max_per_window_reached` and `min_gap_not_elapsed`. If both limits apply, the window cap is reported first.
- **Reservation id:** it encodes the `userId`, so any worker can release it without a global index. Releasing an unknown or already-released id does nothing.
- **Crashed workers:** a reservation whose worker dies before sending or releasing keeps counting. That under-sends rather than over-sends, which protects the sender reputation.
- **Corrupt state:** throws instead of resetting, because a reset would silently lift every limit.
- **Retention:** entries older than 30 days are pruned. `windowHours` is capped at 720 to stay within that.

**Verification**
- Tests cover the cap, the gap, the sliding window, per-call limits, lead independence, release and idempotent release, persistence across a fresh module instance, 25 concurrent calls in one process, 12 concurrent child processes sharing one budget, release from a different process, malformed input, corrupt state, and the missing `STATE_DIR` error.
- The suite passed on five consecutive runs with no leftover temp directories.
- **Not verified on Node 22.** Only Node 24.13 is available here, so the code sticks to APIs that exist in 22, but that is unconfirmed.

**Known limit:** a stale lock is broken after 10 seconds. A narrow race exists when a lock is broken right as a live holder takes it. The critical section takes milliseconds, so this only matters after a crash, but it is not impossible.

Nothing was committed.
