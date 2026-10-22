`bot.mjs` is written at `work/ours-g4-2/bot.mjs`. It exports `reserve(request, now)` and `release(reservationId)`, with no dependencies, and I checked it with a test script. Nothing was sent.

**Tests:** all seven checks pass, run from `/tmp/bot-test/test.mjs` (outside the repo). They cover:
- 12 separate processes racing on one lead with a limit of 3: exactly 3 are allowed.
- The 90-minute gap.
- The rolling 1-hour window, where a slot frees once its oldest send ages out.
- Releasing a slot from another process, and a repeated release doing nothing.
- A released slot not counting toward the gap.
- Recovery from a stale lock left by a crashed worker.
- Bad input throwing before anything is written.

The machine has Node v24.13.0, not 22. The code uses only standard `node:` APIs, so it should run on 22, but I did not test on 22.

**Choices I made:**
- **Counted sends:** every reservation not released counts, including ones whose send outcome is unknown. Those may already have reached the lead.
- **Window:** rolling. Any `windowHours` span holds at most `maxPerWindow` counted sends.
- **Gap:** a counted send less than `minGapMinutes` away in either direction blocks the new one. The two directions cover caller clocks that disagree.
- **Reasons:** `min_gap_not_elapsed` and `max_per_window_reached`. The gap check runs first, so when both apply the gap reason is returned.
- **Release:** removes the reservation from the lead's file. Unknown, malformed or repeated ids are no-ops.
- **Failure:** a corrupt state file or a lock held past 5 seconds throws, so the caller sends nothing.
- **Limits:** history is kept 90 days, so `windowHours` must be at most 2160.

**Storage:** `STATE_DIR/leads/<sha256 of userId>.json`, created if missing. Each call reads the file fresh and takes a per-lead lock directory (`mkdir` is atomic). Writes go to a temp file and are then renamed into place.

**Known gaps:**
- Writes are not fsynced, so a power loss could drop the latest reservation.
- Stealing a stale lock has a very small race window that I did not close.
- The request has no message id, so there is no redelivery dedupe. A retried call with the same lead counts as a new send.

I did not use the proactive-gate library. The project's `package.json` depends on it, but the task asks for no dependencies, and this is a frequency limit rather than consent or quiet-hours logic.
