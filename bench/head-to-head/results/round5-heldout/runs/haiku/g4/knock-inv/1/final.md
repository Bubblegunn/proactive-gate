I wrote `bot.mjs` and it passes a 13-case test suite. Nothing was sent, and nothing is committed.

**File:** `work/knock-inv-g4-1/bot.mjs`. The test script is outside the repo at `/tmp/bot-test-h2h/test.mjs`.

**Behaviour choices:**
- **What counts:** Every granted reservation counts, including ones still in flight or abandoned by a crashed worker, because the lead may have received the message. A `release()` removes the reservation. Blocked attempts are never recorded.
- **Window:** Sliding. A send counts for `windowHours` after it was granted. A fixed window would allow up to 2× the cap around a boundary.
- **Gap:** `minGapMinutes` is measured from the most recent counted send.
- **Reason codes:** `max_per_window_exceeded` and `min_gap_not_elapsed`. If both limits fail, the cap code is returned.
- **Storage:** One JSON file per lead at `STATE_DIR/leads/<sha256(userId)>.json`, written via temp file, fsync, and rename. A corrupt file throws rather than resetting, since a reset would silently lift every limit.
- **Concurrency:** A per-lead lock directory (`mkdir` is atomic) wraps each read-check-write. Locks older than 10 s are treated as left by a crashed worker.
- **Release across workers:** The reservation id is `<lead key>.<uuid>`, so any worker can release it without knowing the userId. A second release, or an unknown id, does nothing.
- **Missing `STATE_DIR`:** `reserve` and `release` throw. The directory is created if absent.

**Tests run:** Cap, gap, sliding-window expiry, per-call limits, release, cross-process reserve and release, a 12-process race for the last 3 slots (exactly 3 allowed, every time across 4 runs), stale-lock recovery, corrupt file, missing env var. All 13 pass on Node 24 and 20. **Node 22 is not installed here**, so I did not test on it. The code uses only long-stable APIs.

**Limits of this design:**
- **Single machine only.** The lock relies on local-filesystem `mkdir` semantics. It will not coordinate across hosts or on NFS.
- **Crash after reserve, before send:** the slot stays consumed. This is deliberate, but it can under-send.
- **Stale-lock race:** in a very narrow window, two workers recovering the same stale lock at once could remove a fresh lock. The holder only works for milliseconds, so this is unlikely.
- **History retention:** entries are pruned to the longest window or gap seen so far for that lead. If a later call uses a longer window than any earlier call did, sends already pruned are not counted. This only matters if campaign settings for a lead change upward.
