`bot.mjs` is written and all 15 tests pass, including a cross-process test. Nothing was sent.

Files are in `work/knock-inv-g4-2/`:
- `bot.mjs`: exports `reserve(request, now)` and `release(reservationId)`.
- `bot.test.mjs`: runs under `node --test` against a temp `STATE_DIR`, so the real shared state is untouched.

**Decisions:**
- **What counts:** a slot counts from reservation, not provider acceptance. A crash between reserve and send still uses the slot. That over-counts, which is the safe direction for sender reputation.
- **Released slots:** they stop counting for both limits, since the lead never got the message.
- **Window:** rolling, not calendar-day. "At most N in any 24h" is what the recipient feels.
- **Gap:** measured from the most recent counted send, so any two messages to a lead are at least `minGapMinutes` apart.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. The window check runs first when both would block.
- **Storage:** one JSON file per lead, keyed by SHA-256 of `userId`, under `STATE_DIR/leads/`. Writes are atomic (temp file + rename).
- **Locking:** an `mkdir` lock per lead serialises read-modify-write across processes. A lock older than 10s is treated as left by a crashed worker.
- **Corrupt history:** throws instead of resetting, since a reset would erase history and allow over-sending.
- **Reservation id:** `<leadHash>:<uuid>`, so any worker can release it without the reserving process.
- **`release`:** idempotent, and accepts `null` from a denied reserve.

**Verified:**
- Window limit, rolling expiry at exactly 24h, min gap, and per-call limits that differ between calls.
- Release frees the slot and the gap. A second release of the same id is a no-op.
- History survives a restart.
- 15 concurrent child processes against `maxPerWindow: 3` produced exactly 3 allowed.
- A reservation made in one process was released from another.

**Known limits:**
- A worker that crashes after reserve and before send keeps its slot until the window rolls over.
- Stale-lock breaking has a small race if a lock is broken right as its holder recovers. Only reachable after a crash.
- `STATE_DIR` is unset in this environment, so I did not create the real shared directory. `reserve` creates it on first use.

I did not commit anything.
