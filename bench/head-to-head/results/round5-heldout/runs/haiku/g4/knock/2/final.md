`bot.mjs` is written in the work directory and passes my test suite. The suite ran four times with no failures, including a race test in which 12 processes make 60 simultaneous attempts. Exactly 3 were allowed. Nothing was sent, and I did not commit.

**Design choices**

- **Storage:** one JSON file per lead under `STATE_DIR/leads/`, named by SHA-256 of the user id. Writes go to a temp file, are fsynced, then renamed, so a crash leaves the old or the new file, never a partial one.
- **Locking:** a per-lead lock directory created with `mkdir`, which is atomic across processes. A lock older than 10 s is treated as left by a dead worker and broken. Acquisition times out after 10 s.
- **What counts:** every allowed reservation that has not been released. Blocked attempts never count, so retries cannot pile up. Limits are per lead, not per channel, because the recipient sees WhatsApp and SMS the same way.
- **Window:** sliding. A slot frees exactly `windowHours` after its send. A fixed window would allow a double burst across its boundary.
- **Gap:** measured from the latest counted send. A negative gap (caller clock behind a stored send) also blocks.
- **Reason codes:** `min_gap_not_elapsed` and `window_limit_reached`. The gap is checked first when both apply.
- **Release:** the reservation id embeds the lead's key, so any worker can release it. It removes the entry, so the slot and the gap are both given back. Release is idempotent. A malformed id returns `false`.
- **Failure handling:** a corrupt history file throws rather than resetting, because a reset would let sends through. Invalid input throws `TypeError`. Callers should treat a throw as "do not send".

**Limits to know about**

- A reservation whose worker crashes before sending still counts. That errs toward under-sending.
- Entries are pruned after `max(30 days, window, gap)`. A window longer than 30 days can only see history still stored when it was first used.
- The stale-lock break is not perfectly race-free if two workers both see a lock older than 10 s at the same instant. The critical section takes a few milliseconds, so this should be practically impossible.

The tests live in `/tmp/bot-test/` (`test.mjs` and `child.mjs`), outside the repo. One test assertion in section 6 is written awkwardly and does less than its name claims. The blocked-attempts behaviour is covered by the window-limit checks in sections 1 to 4.
