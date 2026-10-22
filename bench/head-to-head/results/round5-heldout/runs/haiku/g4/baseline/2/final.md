`bot.mjs` is written at `work/baseline-g4-2/bot.mjs`. All 10 checks pass, including a cross-process race. Nothing was sent and nothing was committed.

**How it works**
- Each lead has one JSON history file in `STATE_DIR/leads/`. A `mkdir`-based lock per lead in `STATE_DIR/locks/` serializes the check-and-write. Writes go to a temp file, get fsynced, then get renamed, so a restarted worker never reads a half-written history.
- `reserve` checks the cap first (`max_per_window`), then the gap (`min_gap`). If allowed, it records the slot before returning, so a concurrent worker sees it.
- `release(reservationId)` finds the entry by id, marks it released, and returns `true`. It returns `false` for an unknown, malformed, or already-released id. Any process can call it, since state is on disk.

**Choices about what counts**
- Only allowed reservations that were not released count. Blocked attempts never count, so a retrying worker can't lock itself out.
- A slot counts from the moment it is reserved, not when the provider acknowledges it. A worker that crashes mid-send is treated as having sent.
- The window is sliding: a send counts for exactly `windowHours`, not until a calendar day ends.
- The gap is measured from the latest counted send. A send timestamped after `now` (another worker with a slightly fast clock) is blocked, which is the conservative choice.
- Counting is per `userId`. Your request has no channel field, so WhatsApp and SMS to the same lead share one budget. That matches what the lead experiences.

**Tests** (in `/tmp/bot-test/test.mjs`, outside the work tree)
- Cap of 3 blocks the 4th send with `max_per_window`, and the id is `null`.
- Min gap blocks at 89 min and allows at exactly 90.
- The window expires at exactly +24h.
- Release frees the slot from another module instance. A second release returns false.
- A released send does not start the gap clock.
- History survives a fresh process.
- Invalid inputs throw.
- A stale lock left by a crashed worker is broken.
- 12 processes × 20 concurrent attempts: exactly 3 allowed under a cap of 3, and exactly 1 under a 90-min gap.

**Caveats**
- The sandbox runs Node v24.13, not Node 22. I used only long-stable APIs, but I did not run it on Node 22.
- Stale-lock recovery is a time-based heuristic. A holder paused for more than 5s could in theory have its lock broken. The critical section takes milliseconds, so this is unlikely, but it is not fenced.
- Pruning keeps history only as far back as the largest `windowHours` seen for that lead. If a campaign later raises the window beyond that, older sends are already gone and cannot be counted.
- `STATE_DIR` must be set. The module throws if it is missing rather than writing somewhere unexpected. It creates the subdirectories itself.
