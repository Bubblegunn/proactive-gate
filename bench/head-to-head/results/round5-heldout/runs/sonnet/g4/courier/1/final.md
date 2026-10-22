I wrote `bot.mjs` and tested it, including a run with 12 workers asking for the same lead at once. I didn't send anything.

**How it behaves**
- **Shared history:** All reservations are stored in `$STATE_DIR/reservations.json`, and the directory is created if it's missing. The file is replaced atomically on each write. Every call takes a lock shared by all workers, so check-and-claim happens as one step. A lock left behind by a crashed worker is cleared automatically.
- **Window:** It slides. Only sends in the last `windowHours` count, so each slot frees up exactly `windowHours` after its own send. There is no midnight reset that would let a lead get a burst right after a boundary.
- **What counts:** Only reservations that are still held count. A refused request claims nothing and doesn't extend the wait. A released slot is removed completely, so it counts toward neither the window limit nor the gap.
- **Reasons:** `min_gap` means the lead was messaged less than `minGapMinutes` ago. `window_limit` means they already have `maxPerWindow` sends in the window. If both apply, `min_gap` is reported.
- **Limits per call:** The limits come from each call's own `request`, so they can differ between campaigns.
- **Release:** `release` looks the id up in the shared file, so any worker can release it. An unknown or already-released id does nothing.
- **Cleanup:** Entries older than 30 days, or older than the call's window if that is longer, are pruned.

**What I checked**
- A sequence with max 3 per 24 hours and a 90-minute gap gave the expected results. The gap refusal, the window refusal, the freed slot after `release`, and the slot opening again after 24 hours all behaved correctly.
- With 12 processes asking for the same lead at the same instant, exactly 1 was allowed and 11 got `min_gap`.

**Limits and assumptions**
- It uses one global lock. That is fine for about a dozen workers, but it would become a bottleneck at much higher volume.
- It trusts the `now` each caller passes in. If caller clocks drift apart, the gap check uses the absolute difference between times.
- If `reservations.json` is corrupted, it throws an error. It does not reset the history, because resetting would let leads be messaged again.

I didn't add test files to the repo. My test script is in `/tmp/courier-test`.
