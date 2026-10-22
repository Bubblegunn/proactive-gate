`bot.mjs` is written at `work/baseline-g4-3/bot.mjs`. It exports `reserve(request, now)` and `release(reservationId)`. All 15 tests pass. I did not commit anything.

**How it behaves**

- **Storage:** each lead gets its own history file under `$STATE_DIR/leads/`, named by a SHA-256 of the `userId`. `STATE_DIR` is created if missing. Writes go to a temp file, are fsynced, then renamed, so a crash cannot leave a half-written history.
- **Concurrency:** each lead has a lock directory (`mkdir` is atomic). `reserve` and `release` both take it, so twelve processes racing on one lead still produce exactly `maxPerWindow` sends. A lock older than 10 s is treated as left by a crashed worker and broken.
- **What counts:** a reservation counts from the moment it is allowed until `release` removes it. A denied attempt is never recorded, so it does not extend the cooldown. A released reservation (provider rejected it) stops counting. A reservation whose worker crashed before sending still counts, which over-counts but errs toward not spamming.
- **Window:** `maxPerWindow` is a rolling window over the last `windowHours`, not a calendar-day reset. A reset would allow a burst across the boundary.
- **Gap:** `minGapMinutes` is measured from the most recent counted send. A denied attempt does not restart the gap.
- **Reason codes:** `max_per_window_reached`, `min_gap_not_elapsed`. If both apply, the window reason is returned.
- **Release:** `reservationId` embeds the lead's key, so any process can release it without knowing the `userId`. Releasing an unknown, malformed or already-released id returns `false`.

**Failure behaviour (my choices)**

- If the lock cannot be taken within 5 s, `reserve` returns `allowed: false` with reason `limiter_busy`, so the caller does not send.
- If the lock cannot be taken during `release`, it throws. The slot is then not returned, so the caller should retry or report it.
- Invalid arguments throw `TypeError` or `RangeError`.

**Testing**

The tests live in `/tmp/bot-test/`, outside the repo. They cover:
- both limits and the rolling-window roll-off;
- gap measured from the last allowed send;
- per-call limit values;
- release, including release from a separate process;
- invalid inputs;
- stale-lock recovery;
- twelve concurrent processes against one lead, with and without a minimum gap;
- no leftover temp or lock files.

Nothing was sent.

**Limits of this design**

- It assumes all workers are on one machine with a local filesystem. `mkdir` locking is not reliable on network filesystems.
- Stale-lock breaking has a tiny check-then-remove race. It is only reachable if a live lock is held for more than 10 s.
- Reservations from crashed workers never expire, so those slots are lost until they age out of the window.
- There is no retry-after hint in the response; the spec did not ask for one.
