I wrote `bot.mjs` and tested it. It works in a sequential run and in a 12-process race. Nothing was sent.

**Behaviour**
- **Window:** it is a sliding window. A reservation counts for `windowHours` after its own time. A lead can never get more than `maxPerWindow` messages in any `windowHours` span, and there is no midnight reset.
- **Min gap:** a new send is blocked until `minGapMinutes` have passed since the lead's most recent reservation. A reservation dated in the future, from clock skew between workers, also blocks.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. If both limits apply, you get `window_limit_reached`.
- **Denied calls:** a denied call uses no slot.
- **Release:** a released slot stops counting toward both limits. Releasing twice, or releasing an unknown id, does nothing. The id encodes which lead it belongs to, so any worker can release it.
- **Per-call limits:** limits are read from each call, so campaigns can differ.

**Storage**
- **Files:** `STATE_DIR` holds one JSON file per lead, and it is created if missing. Writes go to a temp file and are renamed into place.
- **Locking:** a per-lead lock file serialises the read-check-write step across processes. A lock from a dead process, or one older than 15 seconds, is broken automatically.
- **Retention:** history is kept for 90 days. A campaign window longer than that would be cut short.

**Tests** (scratch script in `/tmp/courier-test`)
- **Sequential run:** with 3 per 24h and a 90-minute gap, the gap block, release and re-reserve, the window block, and the window sliding forward all behaved as expected.
- **Race:** 12 processes tried to reserve the same lead with a limit of 5. Exactly 5 were allowed and 7 denied.

The lock-breaking has a rare race: two workers could break the same stale lock at once. I didn't test a crashed worker holding a lock.
