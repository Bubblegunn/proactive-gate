`bot.mjs` is written in the work directory and both self-checks pass. It is the only file I added.

**Behaviour**
- **Window:** at most `maxPerWindow` sends in any rolling `windowHours`. The window slides, so a slot frees when its oldest send is older than the window.
- **Gap:** a new send must be at least `minGapMinutes` from every counted send, before or after it. Exactly the gap is allowed.
- **What counts:** a reserved slot counts immediately, including when the outcome is unknown, since the lead may have received it. `release` removes it, so it stops counting. A second release is a no-op.
- **Reason codes:** `window_limit` and `min_gap`. The window cap is checked first.
- **State:** one JSON record per lead in `STATE_DIR/users`, keyed by hex-encoded userId. A lock directory per lead in `STATE_DIR/locks` serializes read-modify-write across processes. Writes go through temp file and rename. `STATE_DIR` is read and created on every call.
- **Release id:** `reservationId` is `<hex userId>.<uuid>`, so `release` finds the record without an index.
- **Retention:** records keep sends for the longest window seen for that lead.
- **Bad input:** throws a `TypeError` (and `reserve` throws if the lock cannot be taken in 15 s). The caller must treat a throw as "do not send".

**Verification**
- In-process checks: gap refusal, exact-gap allowance, window cap, release and re-reserve, double release, sliding window aging out, `maxPerWindow: 0`, invalid input rejected.
- Cross-process race: 12 separate Node processes reserved for the same lead at once with a cap of 3. Exactly 3 were allowed and 9 refused with `window_limit`. Lock directories were all cleaned up.
- The test ran in a temp directory outside the repo. Nothing was sent.

**Caveats**
- I ran on Node 24.13.0, not Node 22. The code uses only built-ins available in 22, but I did not run it on 22.
- The request has no message id, so `reserve` is not idempotent across retries. Callers should not retry a `reserve` call blindly.
- Stale-lock breaking has a small race. A lock is treated as abandoned after 10 s, and two workers can both try to break it at the same instant. Holds are milliseconds, so this is unlikely, but it is not zero.
- `package.json` still lists `proactive-gate` as a dependency. `bot.mjs` does not import it, and I left `package.json` as it was.
