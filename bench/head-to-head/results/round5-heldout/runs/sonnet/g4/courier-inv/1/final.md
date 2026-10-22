`bot.mjs` is written and passes my checks. The only change to `/tmp/courier-test/test.mjs` was my own fix: the child processes had been picking a new state directory each. Nothing was sent.

**Behaviour**
- **Storage:** one JSON file per lead in `STATE_DIR` (created if missing). A per-lead lock file stops two workers from claiming the same slot. If a worker crashes while holding the lock, the next worker detects the dead process and takes the lock over.
- **What counts:** every active reservation counts from the moment it is reserved, since the send follows immediately. A refused request records nothing, so refusals don't extend the wait.
- **Window:** it slides. A send counts for `windowHours` after it, with no midnight or fixed reset, so a lead can't get a burst across a boundary.
- **Gap:** `minGapMinutes` is measured against the closest active reservation in either direction in time, so worker clocks that are slightly out of step can't squeeze two messages together.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. If both limits apply, the window code is returned.
- **`release(id)`:** the id contains the lead's key, so any worker can release it. Releasing an unknown or already-released id does nothing, so a retry is safe.
- **Retention:** entries older than 30 days are pruned.

**What I checked**
- A second send is blocked by the gap, and a fourth is blocked by the cap.
- A release frees the slot.
- The window slides as time passes.
- Different leads don't affect each other.
- 12 separate processes asking for the same lead at the same instant got exactly 3 allowed.

I didn't test recovery from a crashed lock holder. The Courier skill is about Courier's send API, so it didn't change this design. This limiter doesn't call Courier.
