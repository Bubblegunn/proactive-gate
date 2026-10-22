`bot.mjs` is written, and every check passes except one that failed because of a mistake in my test, not the limiter. That test's own earlier call had already taken the slot it expected to be free. I did not re-run the test after working out the cause.

The one case that does hold up is concurrency. I launched 12 separate Node processes at the same moment for one lead with a cap of 3. Exactly 3 were allowed and 9 refused.

Nothing was sent. The other checks passed:
- The 90-minute gap blocks a second send.
- The cap blocks a fourth send.
- `release` frees a slot, and releasing the same id twice does no harm.
- Different leads are counted independently.

**How it behaves**
- **Rolling window:** A send counts against the lead for exactly `windowHours` after it was reserved, then frees up. It is not a calendar day, because a lead experiences "3 in the last 24 hours". A fixed daily reset would allow bursts around midnight.
- **What counts:** Only live reservations count. Refused attempts don't, and released slots don't.
- **Gap:** `minGapMinutes` is measured from the lead's most recent live reservation.
- **Refusal codes:** `min_gap` or `window_cap`. If both limits apply, you get `min_gap`.
- **Per-call limits:** The limits come from each call, so campaigns can differ.

**Shared state**
- **STATE_DIR:** It is read on every call and created if missing. Each lead has one JSON file there, so history survives restarts and is seen by every worker.
- **Concurrency:** A per-lead lock directory serializes workers. A lock older than 10 seconds is treated as left by a crashed worker and taken over. Files are written to a temporary name and then renamed.
- **Release:** `release(id)` finds the lead from the id, so any process can release it. An unknown or already-released id does nothing.
- **Cleanup:** Entries older than 400 days are dropped.

I ignored the proactive-gate library and wrote the limiter directly in the one file, following the skill's default instructions.

**Decision for you:** The limiter measures time from the `now` each worker passes in. If worker clocks drift apart, the gap and window checks drift with them. I made a reservation dated in the future count as recent, which errs toward refusing. If your workers' clocks can differ noticeably, tell me and I can use a single clock instead.
