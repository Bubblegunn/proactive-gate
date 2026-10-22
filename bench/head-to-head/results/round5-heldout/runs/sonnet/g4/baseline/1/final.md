I wrote `bot.mjs` and my test script passes. The test covers the limit logic, release, and 12 worker processes reserving for the same lead at once, where exactly 3 were allowed. The test script is at `/tmp/rl_test/test.mjs`, outside the repo. Nothing was sent.

**How it stores state**
- Each lead gets one JSON file in `STATE_DIR`, which the code creates if it's missing.
- A per-lead lock file makes check-and-claim atomic across workers. A lock left behind by a crashed worker is broken after 15 seconds.
- Files are written to a temporary name and then renamed, so a restart never leaves a half-written file.

**What counts toward the limits**
- **Window:** it slides. A slot counts for `windowHours` after its send time, so the lead never sees more than `maxPerWindow` texts in any rolling 24 hours. A fixed daily reset would allow a burst across midnight.
- **Gap:** `minGapMinutes` is measured from the most recent live slot, even if that slot is older than the window.
- **Released slots:** a released slot is removed entirely, so it counts toward neither limit. The lead never received that message.
- **Limits:** both come from each call's request, so campaigns can use different values.

**`reserve` and `release`**
- If a call would break both limits, `reserve` returns `window_limit`. A gap-only block returns `min_gap`.
- `reserve` throws on invalid input or a missing `STATE_DIR`. It also throws if a state file is corrupt, or if the lock can't be acquired within 30 seconds. I chose to refuse to send in those cases.
- `release` takes only the reservation id, which includes a code for the lead, so any worker can release it. It returns `true` if it freed a slot. Releasing an unknown or already-released id returns `false` and does nothing.

**Limitation**
- Two workers could both break the same stale lock at the same moment. That needs a crash plus a collision, and the critical section only takes milliseconds.
