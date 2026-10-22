Wrote `bot.mjs` in the work directory. Self-check passed in a temp `STATE_DIR`. Nothing was sent.

**Checks run:**
- 12 separate processes raced for one lead with cap 3: exactly 3 allowed, the rest got `window_limit_reached`.
- Release frees a slot, a second release of the same id is a no-op, and an unknown id returns false.
- Sliding window: room returns once the earliest send is more than 24h old.
- Gap: 89 min blocked with `min_gap_not_elapsed`, 90 min allowed.
- Malformed input throws `TypeError`.
- A fresh process reads the shared state from disk.

**Choices:**
- **What counts:** only reservations not yet released. A released slot is free at once.
- **Window:** sliding. Any `windowHours` span holds at most `maxPerWindow` sends.
- **Gap:** measured from the most recent counted send. `minGapMinutes: 0` disables it.
- **Clock skew:** entries stamped later than the caller's `now` count toward both limits. This errs toward blocking.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. The window cap is checked first.
- **Storage:** `STATE_DIR/leads/<sha256(userId)>.json`, created on demand. Each write goes through a temp file and rename. A lock directory serialises read-modify-write across workers. A lock older than 10 s is treated as left by a crashed worker and broken. Entries are pruned once older than the largest window seen for that lead.
- **Reservation id:** `<leadHash>:<uuid>`. `release` reads the lead from the id, so any worker can release.

**Caveats:**
- The request has no message id, so a caller that retries `reserve` after a timeout spends a second slot. Redelivery safety needs a message id; I did not add one because the spec does not list it.
- A worker that crashes after `reserve` but before sending keeps its slot until it ages out. I kept it because the outcome is unknown, so the slot is not refunded.
- Writes are not fsynced, so a power loss can drop the last write. A process restart is fine.
- The stale-lock path is not exercised by the checks.
- No quiet hours, timezone or consent checks: the request does not ask for them, so I did not add any. Refusals return the codes from the spec, not plain sentences.
- Sandbox runs Node 24; the code uses only Node 22 APIs.
