`bot.mjs` is written at `work/knock-g4-3/bot.mjs`. It exports `reserve(request, now)` and `release(reservationId)`, has no dependencies, and sends nothing. All 13 behavioural checks pass, including 12 and 30 concurrent callers. I ran them on Node 24 because that is what's installed here; I did not run them on Node 22.

**Behaviour I chose**

- **What counts:** only allowed reservations that haven't been released. A denied request is not recorded, so retries don't extend a block. A released reservation stops counting.
- **Reservations never released:** these still count, even if the worker died before sending. Over-counting protects sender reputation. They age out after 30 days.
- **Window:** sliding. Any rolling `windowHours` contains at most `maxPerWindow` sends. A send drops out exactly when it is `windowHours` old.
- **Gap:** symmetric. No counted send may be within `minGapMinutes` of `now`, before or after. This copes with callers whose `now` values arrive out of order.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. Both are checked under the same lock, so only one of them is returned per denial.
- **Reservation IDs:** formatted as `<sha256 of userId>.<uuid>`. Any worker can release any reservation without knowing the userId.
- **`release`:** returns `true` if it freed a slot and `false` for an unknown, malformed or already-released ID. It never frees a second slot.
- **Invalid input or corrupt history:** both throw, so the caller sends nothing (fails closed).

**How it works**

- History is one JSON file per lead under `STATE_DIR/leads/`. Writes go to a temp file, are fsynced, then renamed into place.
- Each lead has a directory lock under `STATE_DIR/locks/`. Locks older than 10 seconds are treated as left by a dead worker and removed.
- `STATE_DIR` is created if missing. It must be on a local filesystem, because the locking relies on atomic `mkdir`.

**Not covered**

- The return shape has no retry-after hint, since the spec didn't ask for one.
- `windowHours` is capped at 720 (30 days), because history is kept for 30 days.
- Nothing was run on Node 22 itself.

The test harness is in `/tmp/bot-check/` (`check.mjs` and `worker.mjs`), outside the work directory. Nothing was committed.
