`bot.mjs` is written and works in the checks I ran. It exports `reserve(request, now)` and `release(reservationId)`, both synchronous. I did not send anything.

**How it behaves**
- **Shared state:** history is in `STATE_DIR/rate-limit/`, one file per lead. `STATE_DIR` is read on every call, and the directory is created if missing. History survives restarts and is shared by all workers.
- **Locking:** each lead has its own lock, so two workers cannot both take the last slot. A lock left behind by a crashed worker is cleared after 10 seconds, and writes go to a temp file and are then renamed.
- **Rolling window:** a slot counts while it is less than `windowHours` old. A slot exactly `windowHours` old no longer counts.
- **Minimum gap:** it is measured from the lead's latest slot. A send exactly `minGapMinutes` later is allowed.
- **What counts:** a reserved slot counts even if the send outcome is unknown. Only `release` frees it. Refused attempts cost nothing, so retries do not push the lead's quota further out.
- **Refusal codes:** `max_per_window` or `min_gap`. If both limits apply, the code is the one that clears later.
- **Release:** the reservation id contains the lead, so any worker can release it. Releasing an id that is unknown or already released returns `false` and does nothing.
- **Limits per call:** the limits come from each call, so campaigns can differ. Slots older than 30 days are dropped.

**Checks run**
- The first reserve is allowed.
- A send at 89 minutes is refused with `min_gap`, and one at exactly 90 minutes is allowed.
- With a cap of 3, the 4th send is refused with `max_per_window`.
- Release works once and returns `false` the second time, and the slot can be reserved again afterward.
- 12 separate processes asking at the same instant with a cap of 5 were allowed exactly 5 times.

**Not checked**
- Restart persistence was not tested separately. It follows from the state being files, and the concurrency test did use separate processes.
- Behaviour with a corrupt state file was not tested. The code throws rather than allowing a burst.

**Two things to know**
- `release` frees a slot even if the message was actually delivered, so only call it when the send definitely did not happen. If the outcome is unknown, keep the slot.
- This limiter only checks send frequency. It does not check consent, opt-out or quiet hours, so those checks must run before `reserve`.
