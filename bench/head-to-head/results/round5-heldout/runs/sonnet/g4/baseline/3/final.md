`bot.mjs` is written and works. My test passed: gap and window limits, release, window sliding, and 12 processes racing for one lead. Exactly 3 of the 12 got a slot, which matches the limit of 3.

**How it works**
- **Storage:** each lead gets one JSON file in `STATE_DIR`, and the directory is created if missing. History survives restarts and is visible to every worker.
- **Concurrency:** a per-lead lock directory, created atomically, makes check-and-claim one step, so two workers can't both take the last slot. If a worker crashes while holding the lock, others take it over after 30 seconds. A corrupt state file throws an error instead of letting a burst through.
- **Reservation ids:** each id includes the encoded lead id, so `release` can find the right file from any process.

**Behaviour you may want to change**
- **Sliding window:** a slot counts for `windowHours` after its own time. It is not a fixed daily reset, so a lead can't get a burst right after midnight.
- **Reason codes:** `min_gap` and `window_limit`. If both apply, `min_gap` is reported.
- **Gap check:** the gap is measured against the nearest slot in either direction, because workers' clocks can differ slightly.
- **What counts:** every reserved slot counts, since we can't know whether the lead saw the message. A released slot counts for nothing. That also frees the gap, so a retry can go out right away. Rejected attempts aren't recorded, so retrying never extends a lead's wait.
- **Release:** releasing twice or releasing an unknown id does nothing.
- **Input errors:** missing `userId` or invalid limits throw an error instead of silently allowing the send.
- **Cleanup:** slots older than 90 days are dropped whenever a lead's file is rewritten.

I did not send anything. The test file is `/tmp/h2h-test/test.mjs`, outside the repo.
