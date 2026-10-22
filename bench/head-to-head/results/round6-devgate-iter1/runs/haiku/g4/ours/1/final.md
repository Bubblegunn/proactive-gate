I wrote `bot.mjs` with `reserve` and `release`. Checks passed against a temp `STATE_DIR`, and nothing was sent.

**Behaviour**
- **Per-lead history:** one JSON file per lead under `STATE_DIR/send-limits/`. The file name is a hash of `userId`. Writes go to a temp file and are then renamed, so a half-written file is never read.
- **Locking:** each lead has a lock directory created with `mkdir`, which is atomic across processes. A lock older than 10 s is treated as left by a crashed worker. A caller that waits more than 5 s gets a thrown error, not a refusal, because nothing was reserved and the caller must not send.
- **Limits, checked in this order:**
  - `min_gap_not_elapsed`: any held send within `minGapMinutes` of `now`, in either direction, so clock skew cannot slip a second send in.
  - `max_per_window_reached`: held sends in the last `windowHours`. This is a sliding window: a slot frees when the oldest send ages out.
- **What counts:** a reservation counts as soon as it is claimed. An unknown outcome stays held, because the lead may already have the text. `release` marks an entry `released` and it stops counting. Releasing twice, or releasing an unknown id, returns `false` and changes nothing.
- **Release from any worker:** the reservation id starts with the lead's hash, so `release` finds the right file without knowing the `userId`.

**Checks run**
- Gap refusal, window-full refusal, and release freeing a slot.
- Release is idempotent, and a different lead is unaffected.
- 12 processes racing for one lead with a limit of 3: exactly 3 were allowed.

**Choices you may want to change**
- History is pruned after 30 days. A `windowHours` above 720 would miscount.
- A stale-lock takeover can race in theory if two workers both see the same stale lock at the same moment. A 10 s threshold makes that unlikely.

**Not included**
- No consent, opt-out, quiet-hours or time-zone checks. The request gives no fields for them and does not ask for them, so I did not add them. Tell me if you want them in `reserve`.
- No message-id idempotency. The request has no message id, so a retried call with the same id is treated as a new reservation.

I did not use the proactive-gate library. Its skill guidance says to write a single file for a task like this, and the task asks for a rate limiter rather than a full policy gate. Nothing was committed.
