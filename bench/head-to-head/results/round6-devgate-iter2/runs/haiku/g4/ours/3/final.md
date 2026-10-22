`bot.mjs` is written in the working directory, exports `reserve(request, now)` and `release(reservationId)`, and passes a cross-process check. Nothing was sent.

**Check run** (temp `STATE_DIR`, 12 separate Node processes racing for `lead_204` with `maxPerWindow: 3`):
- Exactly 3 allowed; the other 9 got `window_limit_reached`.
- A release from a different process returned `true`, and the next reserve at the same instant was allowed.
- A second release of the same id returned `false`.
- A reserve 30 minutes after the last one, with a 90-minute gap, got `min_gap_not_elapsed`.
- A reserve more than 24 hours later was allowed, so the window rolls.
- A different lead was unaffected.
- An invalid `now` throws.

**Choices I made:**
- **What counts:** every reservation not yet released counts, including sends whose outcome is unknown. A released reservation (provider rejected the message) does not count.
- **Window:** rolling, `(now - windowHours, now]`. Reservations stamped in the future by a skewed worker clock still count.
- **Gap:** the newest counted reservation must be at least `minGapMinutes` before `now`. Gap is checked after the window cap.
- **Concurrency:** each lead has a ledger file under `STATE_DIR/rate-limit/ledgers/` (name is the SHA-256 of the user id). A lock file (`wx` create) serializes each check-and-claim. Writes go to a temp file and are renamed into place. Locks older than 10 s are treated as crashed and broken.
- **Reservation id:** `<ledger key>.<uuid>`, so `release` from any worker finds the right file without a shared index.
- **Retention:** records older than 90 days are dropped, so `windowHours` is capped at 2160 (90 days).
- **Fail-closed:** unset `STATE_DIR` or a corrupt ledger throws instead of guessing. Invalid request fields throw `TypeError`.

**Gaps:**
- `package.json` declares `proactive-gate` as a dependency. I did not use it, because you asked for `bot.mjs` with no dependencies.
- The lock-breaking path has a narrow race: a worker that stalls for more than 10 s could unlink a lock that another worker has since taken. Very unlikely with millisecond critical sections, but not impossible.
- Tested on one machine only, as you described the setup.
