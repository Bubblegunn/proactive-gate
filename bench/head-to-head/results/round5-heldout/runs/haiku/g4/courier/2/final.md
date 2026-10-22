I wrote `bot.mjs` at the repo root (`work/courier-g4-2/bot.mjs`) and tested it with a throwaway script in `/tmp`, which I've deleted. Nothing is committed. The test run used Node 24.13, which is the only version installed here; I did not run it on Node 22, but it only uses standard built-ins.

**How it works**

- **Shared state:** each lead has a history file under `STATE_DIR/leads/`, keyed by a SHA-256 of the userId. A `mkdir`-based lock per lead serializes the check-and-write, so concurrent workers can't both take the last slot.
- **What counts:** a slot counts from reservation until released. Released slots don't count, since the lead never got those messages.
- **Refusals aren't recorded.** If they were, a worker that keeps retrying would keep the window full indefinitely.
- **Window:** sliding, not fixed. At any moment, the sends in the last `windowHours` must stay under `maxPerWindow`. A fixed window would let a lead get double the limit across a boundary.
- **Min gap:** measured from the most recent counted send.
- **Reason codes:** `min_gap_not_elapsed` and `max_per_window_reached`. The gap check runs first.
- **Release:** works from any process, since state is on disk. Releasing an unknown or already-released id is a no-op. A malformed id throws.
- **Writes:** temp file, fsync, then rename, so a crash can't leave a half-written history.
- **Stale locks:** a lock older than 15 s is treated as left by a crashed process and broken.

**Tests (all passed)**

- Cap of 3 per 24 h, with refused attempts not recorded.
- Sliding window that drops old sends at the boundary.
- Min gap at 89 min refused and 90 min allowed.
- Release frees a slot; double release and unknown id are harmless.
- Invalid input throws.
- Stale lock is broken.
- Release from another process.
- History survives a fresh process.
- 12 processes racing on one lead at the same instant: exactly 3 allowed.
- 10 concurrent calls with a 90 min gap: exactly 1 allowed.

**Limits and choices to review**

- A slot is kept if the worker crashes between `reserve` and `release`. That over-counts, which is the safe direction for sender reputation.
- Windows longer than 720 h are rejected, because history is pruned after 30 days.
- The stale-lock break has a very small race if a lock is held for more than 15 s. The critical section takes milliseconds, so this shouldn't happen in practice.
- Locking relies on `mkdir` being atomic. That holds on a local filesystem, not on most network filesystems. Keep `STATE_DIR` local.
- `reserve` returns only the three fields you specified, so it gives no retry-after time. Add one if your callers need it.
