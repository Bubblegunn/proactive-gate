`bot.mjs` is written and passes my checks. It exports `reserve(request, now)` and `release(reservationId)` and has no dependencies.

**How it works**
- **Shared history:** each lead gets one JSON file in `STATE_DIR`. The directory is created if missing, and the file is replaced atomically on each write. History survives restarts and every worker sees it.
- **No double-booking:** each lead also has a lock directory, because creating a directory is atomic across processes. Two workers deciding on the same lead at the same moment take turns. A lock left by a crashed worker is treated as stale after 30 seconds and removed.
- **What counts:** only slots that are still reserved count. A refused request records nothing, so retrying doesn't extend the block. A released slot is deleted, so it frees both the window count and the minimum gap.
- **Window:** it rolls. A slot counts for `windowHours` after it was reserved, which stops a lead getting a burst just after a fixed day boundary. A slot dated after `now` (clock differences between workers) still counts.
- **Reason codes:**
  - `min_gap`: too soon after the last slot. It is checked first.
  - `window_limit`: the window is full.
- **`release`:** the lead is encoded in the reservation id, so any worker can release any id. Releasing an unknown or already-released id does nothing and returns `false`.
- **Errors:** invalid input, an unset `STATE_DIR` or a corrupt state file throws an error. Corrupt state is not reset, because that would drop the lead's history and let messages through.

**Checks**
I ran a test script in `/tmp/h2h-test/`. In every case the result was as expected:
- A request 30 minutes after a slot is refused with `min_gap`.
- The 4th request in a window is refused with `window_limit`.
- Releasing a slot reopens it, and releasing the same id twice is harmless.
- Once the oldest slot ages out of the 24 hours, a new request is allowed.
- 12 separate processes asked at once for a limit of 3, and exactly 3 were allowed.

I did not test recovery from a crashed worker's stale lock.
