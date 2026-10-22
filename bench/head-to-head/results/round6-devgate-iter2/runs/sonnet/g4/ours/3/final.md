`bot.mjs` is written, exports `reserve` and `release`, and passed my checks, including 12 worker processes racing on one lead. I did not test a worker restart or a crashed worker's stale lock, and nothing was sent.

**What the checks showed**
- With the lead_204 limits (3 per 24 h, 90 min gap), the first call was allowed.
- A call 30 minutes later was refused with `min_gap_not_elapsed`.
- A fourth call inside the window was refused with `max_per_window_reached`.
- Releasing a reservation freed its slot, and releasing the same id again did nothing.
- 12 separate processes asked at once with a cap of 3 for the same lead. Exactly 3 were allowed and 9 refused.
- 12 processes, each with a cap far above 12, were all allowed. That shows the lock does not block valid sends.

**How it behaves**
- **What counts:** the limits apply per lead across WhatsApp and SMS together, because the lead experiences the total. A reservation counts as soon as it is claimed.
- **Window:** it slides. A reservation stops counting exactly `windowHours` after it was made.
- **Gap:** the gap is measured from the most recent reservation. If caller clocks disagree, the gap is measured in either direction, which can only make it stricter.
- **Refusal codes:** `min_gap_not_elapsed`, `max_per_window_reached`, and `invalid_request` for a bad `userId`, `now` or limit. The gap is checked before the cap.
- **Release:** `release` deletes the reservation, so it counts toward neither limit again. The reservation id encodes the lead, so any worker can release it. An unknown or already-released id returns false and does nothing.
- **Storage:** `STATE_DIR` is read on every call and created if missing. There is one JSON file per lead, a lock per lead, and writes go through a temp file then a rename. A lock left by a crashed worker is cleared after 10 seconds. Records older than 30 days are pruned.

**Skill rules that did not apply**
- The consent, opt-out and quiet-hours rules from the proactive-gate skill are not in this file. You asked only for a rate limiter.
- No message body is checked, so no "not enforced" line is needed.
