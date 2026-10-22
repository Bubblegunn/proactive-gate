`bot.mjs` is written at `work/knock-inv-g4-1/bot.mjs`, and all 10 behavior checks pass. Nothing was sent and nothing was committed.

**How it works**
- Each customer has one state file under `STATE_DIR/proactive-reserve/`. The file name is a SHA-256 of `userId`, so ids never become paths. The directory is created with its parents if missing.
- Every call takes a per-customer lock file (`open(..., 'wx')`, which is atomic). Other customers are never blocked by it.
- Under the lock it keeps only sends in the window `(now − 24h, now]`, and counts them across all channels.
- If fewer than 5 remain, it appends the send, writes the file via temp file + rename, and returns `{allowed: true, retryAt: null}`.
- If 5 remain, nothing is written. `retryAt` is the 1st-oldest-in-window send's time + 24h, which is the first instant a slot frees. The reason names the limit and gives that time as ISO text.
- Invalid `userId`, `channel`, `now`, or a missing `STATE_DIR` throws a `TypeError` instead of silently miscounting.

**Checks** (in `/tmp/bot-check/check.mjs`, outside the project)
- Five sends are allowed and the sixth is blocked with `retryAt` exactly 24h after the first send.
- A denied call is not counted. One ms before `retryAt` is still blocked; at `retryAt` one slot is free.
- SMS, push and chat share one limit.
- Customers are isolated, including an id containing `/..`.
- The window slides: at 24h+1ms only the oldest send has expired.
- State survives a fresh module import.
- 30 parallel calls in one process give exactly 5 allowed.
- 8 separate Node processes making 4 calls each for the same customer give exactly 5 allowed.

**Limits to know about**
- Counting happens before the send. If the worker crashes between `reserve` and the actual send, that slot is lost. This errs toward the limit, not over it.
- A lock older than 5 s is treated as left by a crashed process and removed. Two processes could both see a stale lock at the same moment and one could remove the other's fresh lock. The critical section is a few ms, so this is unlikely, but it is not impossible.
- This relies on the local filesystem. Shared network mounts such as NFS do not guarantee the `wx` atomicity, so `STATE_DIR` must be local to the server.
- Callers pass `now`, and the logic trusts it. Out-of-order `now` values are handled by sorting, but a badly skewed caller clock can still shift the window.
