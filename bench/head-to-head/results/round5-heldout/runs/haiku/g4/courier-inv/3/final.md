`bot.mjs` is written and its 13 tests pass. Nothing was sent.

The Courier skill didn't apply here. The limiter is local file state, with no Courier API calls, so I didn't use any of its SDK patterns.

**Files** (in `work/courier-inv-g4-3/`)
- `bot.mjs`: exports `reserve(request, now)` and `release(reservationId)`. No dependencies.
- `bot.test.mjs`: `node --test bot.test.mjs`.

**Behaviour**
- **Storage:** one JSON file per lead under `$STATE_DIR/leads/`, keyed by a hash of the userId. Writes go to a temp file and are renamed into place. `STATE_DIR` must be set. The code creates it if missing. An unset variable throws.
- **Concurrency:** a per-lead lock directory (`mkdir` is atomic) wraps each read-check-write, so two workers can't both take the last slot. Locks older than 30 s are treated as left by a dead process and removed.
- **What counts:** a granted reservation counts from grant until released. A reservation that is never released stays counted, because the message may have left. Denied attempts never count.
- **Window:** rolling. A send counts for exactly `windowHours` after its `now`, so a burst at 23:59 doesn't reset at midnight.
- **Gap:** measured from the most recent counted send. A release can make an earlier send the most recent one.
- **Reasons:** `window_limit_reached` and `min_gap_not_elapsed`. If both trip, the window reason wins.
- **Release:** the reservation id encodes the userId, so a different process can release it. Releasing twice returns `false` the second time.
- **Corrupt history:** throws instead of resetting, because a reset would grant a fresh burst.
- **Input:** invalid requests and non-Date `now` values throw `TypeError`.

**Tests cover:** the window limit, rolling expiry, the gap boundary, reason precedence, per-lead isolation, release (including from another process and idempotent), history surviving a restart, 12 processes racing on one lead (exactly 3 allowed), corrupt files, and invalid input.

**Known limits**
- History retention only grows. It keeps the longest window and gap any caller has requested, so one call with a 90-day window keeps all history for that lead.
- Writes are not fsynced. A machine crash mid-write could lose the latest send.
- Stale-lock removal has a tiny race if a holder stalls for more than 30 s. The lock is held for milliseconds, so I judged this acceptable.
