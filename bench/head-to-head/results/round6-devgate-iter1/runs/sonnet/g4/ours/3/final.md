`/bot.mjs` is written and tested. It exports `reserve(request, now)` and `release(reservationId)`, both synchronous, which is fine because callers await them.

**What I checked:**
- **Scripted run:**
  - The first send was allowed.
  - A second send 89 minutes later was refused with `min_gap_not_elapsed`.
  - Sends at 90 and 180 minutes were allowed.
  - A fourth send at 270 minutes was refused with `max_per_window_reached`.
  - After releasing the 90-minute slot, a send at 270 minutes succeeded.
  - Releasing the same id twice returned true, then false.
  - At exactly 24 hours the oldest send no longer counts.
- **Race test:** 12 separate processes asked for the same lead at the same moment with a cap of 3. Exactly 3 were allowed and 9 refused.
- **Not tested:** a worker restart, and recovery after a worker crashes while holding the lock. The history is stored in files, so it survives a restart by design, and the stale-lock recovery is untested code.

**Behaviour I chose:**
- **Window:** it rolls. A send counts against the lead's cap for exactly `windowHours` after it was reserved. At the end instant it stops counting. A fixed daily reset would let a lead get 2×max messages across midnight.
- **Gap:** it is measured from the lead's most recent held send.
- **Released slots:** they count toward neither the cap nor the gap, since the lead never received the message.
- **Refused attempts:** they cost nothing and are not recorded.
- **Limits:** they are read on every call, so each call can use different values.
- **Refusal codes:** `min_gap_not_elapsed` and `max_per_window_reached`. If both limits apply, the gap code is returned.
- **Bad input:** a missing `userId`, a non-numeric limit or an invalid `now` throws an error.

**Storage and concurrency:**
- **Reading `STATE_DIR`:** it is read on every call, and the directory is created if missing. A missing `STATE_DIR` throws.
- **Per-lead storage:** each lead has its own file, named by a hash of `userId`.
- **Locking:** the file is guarded by a lock directory, and writes go to a temp file and are then renamed. A lock older than 10 seconds is treated as a crashed worker and removed. A worker waits up to 30 seconds for a lock before throwing.
- **Reservation id:** it contains the lead's hash, so `release` can find the right file from any process. Ids that don't match that format return false.
- **Old history:** entries older than 90 days are dropped when that lead is next reserved.

Because the cap and window are per call, 90 days is enough only if no campaign uses a window longer than that.

**Not enforced (these are my assumptions, not your requirements):**
- Consent, STOP handling, quiet hours and legal contact hours. This file only does the shared rate limit. Run those checks before calling `reserve`.
- Deduplicating redelivery by message id. Your `request` has no message id, so a retried call claims a second slot. If you keep an id on the sender side, release the earlier slot first.
