`bot.mjs` is written, and the checks I ran passed. Nothing was sent.

**How it works**
- **Storage:** each lead gets its own small file in `STATE_DIR`, which is created if missing. Every worker reads and writes the same file under a per-lead lock file, so the history survives restarts.
- **Crash safety:** a lock left behind by a crashed worker is taken over after 10 seconds. Writes go to a temp file and are then renamed into place, so a crash can't leave a half-written file.
- **What counts:** only reservations that are still held count. A refused attempt is never recorded, so retrying doesn't extend the block. A released slot is removed entirely, so it frees both the count and the gap.
- **Window:** it slides. A slot counts until `windowHours` after it was reserved, not until a fixed daily reset. A lead therefore never gets more than `maxPerWindow` messages in any rolling window.
- **Minimum gap:** it is measured from every held reservation, in both directions, so workers with slightly different clocks can't land two messages close together.
- **Refusal reasons:** `window_limit` and `min_gap`. If both apply, `window_limit` is returned.
- **`release`:** the lead id is encoded in the reservation id, so any worker can release it. Releasing an unknown or already-released id does nothing.
- **Bad input:** invalid requests, a missing `STATE_DIR` or a corrupt state file throw an error instead of allowing a send. A bad request therefore can't cause a message to go out.
- **Blocking:** both functions are synchronous and block while they wait for the lock, which is brief. Callers can still `await` them.

**What I checked**
- The first call was allowed.
- A call 1 hour later was refused with `min_gap`.
- A fourth call inside the window was refused with `window_limit`.
- After releasing a slot, the next call was allowed. Releasing the same id twice did no harm.
- Once the oldest slot aged out of the 24-hour window, a call was allowed again.
- With 12 separate processes reserving for the same lead at the same moment (limit 3), exactly 3 were allowed.

History older than 366 days is pruned. I kept it that long because the limits can differ on every call, so I can't know the longest window anyone will use.
