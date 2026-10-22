`bot.mjs` is written and tested. It exports `reserve(request, now)` and `release(reservationId)`, both async, with no dependencies.

I wrote the limiter directly instead of using the proactive-gate library. The library checks consent, quiet hours and time zones, and you asked only for a rate limit.

**How I checked it**
- 12 separate worker processes asked for the same lead at once with a cap of 3. Exactly 3 were allowed.
- On one lead, with a cap of 2, a 90-minute gap and a 24-hour window:
  - The first send was allowed.
  - A second at +30 minutes was refused with `min_gap`.
  - A second at +100 minutes was allowed.
  - A third at +300 minutes was refused with `window_limit`.
  - After releasing the second reservation, a send at +300 minutes was allowed again.
  - Releasing the same id twice was harmless.
  - A different lead was not affected.
  - Once the first send was more than 24 hours old, a new one was allowed.

I did not test a worker restart or stale-lock recovery. I did not send anything.

**How it works**
- **Shared state:** history is one JSON file per lead under `$STATE_DIR/send-limiter/`. The directory is read on every call and created if missing. A lock per lead and an atomic file replace mean two workers cannot both take the last slot, and the history survives restarts.
- **Release from any worker:** the reservation id contains a hash of the lead's id, so any worker can find the right file. Releasing an unknown, malformed or already released id does nothing.
- **Sliding window:** a send counts against the limit until exactly `windowHours` after it was reserved. There is no reset at midnight, so a lead cannot get a burst right after a reset. Only active reservations count; released ones do not.
- **Minimum gap:** it is measured from the most recent active reservation, so a released slot does not delay the next send.
- **Refusal codes:** `window_limit` and `min_gap`. If both apply, it returns `window_limit`. A malformed request returns `invalid_request`.
- **Clock:** all times come from the `now` the caller passes in.

**Limits and assumptions**
- History is kept for at least 90 days, longer if a window is longer. I chose this so a later call with a larger window still sees old sends.
- A lock held for more than 30 seconds is treated as left over by a crashed worker and taken over. A call waits up to 20 seconds for a lock before throwing.
- A failed send that you do not release still holds its slot. Release only when the provider definitely rejected the message.
