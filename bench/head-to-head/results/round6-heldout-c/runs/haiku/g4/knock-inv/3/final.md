`bot.mjs` is written at `work/knock-inv-g4-3/bot.mjs`. All checks pass, including a run with 20 separate Node processes hitting the same customer at the same instant, which allowed exactly 5.

**How it works**
- Each customer has one JSON state file in `STATE_DIR/users/`, named by the SHA-256 of the `userId`. Other customers' files are never touched.
- Before reading or writing, the call takes a per-customer lock file created with `open(..., "wx")`. That is atomic across processes, so concurrent workers queue on the lock.
- State is written to a temp file, fsynced, then renamed into place. A crash cannot leave a half-written file.
- Only the 5 most recent allowed send times are stored. The count in the last 24 hours is therefore exact, and the file stays small.
- If the window is full, `retryAt` is the oldest of those 5 sends plus 24 hours. Calls before that instant are denied, and the call at that instant is allowed. Denied calls are not counted.
- Channel affects only the reason text. The limit is shared across sms, push and chat.

**Choices you may want to change**
- Invalid input (bad `userId`, unknown channel, non-Date `now`, unset `STATE_DIR`) throws a `TypeError` or `Error`. It does not return `allowed: false`, so a bad call is not mistaken for a rate-limit denial.
- A corrupt state file throws rather than resetting the count. The send then does not happen, which fails closed.
- A lock older than 10 seconds is treated as left behind by a crashed process and removed. A very slow process could still race on that removal. The critical section is a few milliseconds, so I judged this acceptable.
- `now` is trusted as given. Out-of-order `now` values work, but the window is only as accurate as the callers' clocks.

**Verification**
My test script is in `/tmp/bot-check/`, outside the repo. It checks:
- 5 mixed-channel sends allowed and the 6th denied, with the exact `retryAt`
- denial just before `retryAt` and allowance at it
- a second customer unaffected
- 20 concurrent processes allowing exactly 5
- invalid inputs rejected
- no leftover temp files

State persists across restarts because every call reads it from disk. The concurrency test uses separate processes, so it covers that path. I did not send anything.

The Knock skill I loaded is guidance for notification copy and channels, not a rate-limiting API, so it did not change the design.
