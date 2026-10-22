`bot.mjs` is written and tested. 12 worker processes racing on one lead, with a cap of 3, got exactly 3 slots.

**How it works**
- **History:** one JSON file per lead in `STATE_DIR`, created if missing. A per-lead lock file (`open` with `wx`) serialises workers, and a lock left by a crashed worker is taken over after 10 seconds. Writes go to a temp file and are renamed into place, so a restart loses nothing.
- **Window:** it is rolling, not a calendar day. A lead never gets more than `maxPerWindow` messages in any `windowHours` span.
- **What counts:** every live reservation counts, including a send still in flight. A released slot counts for neither the cap nor the minimum gap. A denied call is not recorded, so it does not push back the next allowed time.
- **Reasons:** `window_cap` and `min_gap`. If both limits apply, it reports the one that clears later.
- **Release:** `release` finds the lead from the id, so any worker can call it. Releasing an unknown or already-released id does nothing.
- **Failure handling:** if a history file is corrupt, it throws instead of treating the lead as having no history. Letting it through would bypass the limits.
- **Pruning:** reservations older than 7 days (or the call's own window or gap, if longer) are dropped when that lead is next reserved.

**Tested:** the min gap, the window cap, a released slot returning to the lead, a slot freeing as the window moves, separate leads staying independent, and the 12-process race above. The script is `/tmp/t.mjs`, outside the repo. Nothing was sent.

**Trade-offs**
- Timing uses the `now` each caller passes, so large clock differences between workers would skew the gap.
- If a worker crashes after `reserve` but before sending, the slot stays counted. That errs toward fewer messages to the lead.
