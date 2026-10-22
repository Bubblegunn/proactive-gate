`bot.mjs` is written at the project root and passes a multi-process test suite. Nothing was sent.

**Behaviour**
- **Shared state:** history is one JSON file per lead in `STATE_DIR/leads/`, keyed by a SHA-256 of `userId`. `STATE_DIR` is created if missing. Writes go to a temp file, are fsynced, then renamed, so a restart never sees a partial file.
- **Locking:** each read-modify-write runs under a per-lead `mkdir` lock. Only one worker at a time can decide for a given lead, so the race is closed. A lock older than 5 s is treated as left by a crashed worker and removed. If a lock can't be taken within 10 s, `reserve` throws instead of allowing or denying, since that's an infrastructure failure, not a limit.
- **Window (`maxPerWindow`):** sliding. A lead can get at most N sends in any span of `windowHours`. A slot reopens when the oldest send in the span ages out, not at a fixed reset.
- **Gap (`minGapMinutes`):** no two sends to the same lead closer than the gap, in either direction. The check is symmetric so out-of-order `now` values from different callers can't slip past it.
- **Released slots:** a released reservation no longer counts toward either limit.
- **Crashed sends:** a reservation whose worker died before sending still counts. This errs toward under-sending, which protects the sender reputation.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. `reason` is `null` when allowed.
- **Release:** `reservationId` encodes the lead key, so any worker can release it. `release` returns `true` if it freed the slot, `false` if it was already released or already pruned. It is idempotent.
- **Retention:** history is pruned once it is older than the largest window or gap any caller has used for that lead.

**Tests** (`/tmp/bot-test/test.mjs`, outside the repo; it spawns real child processes)
- 48 concurrent reserves across processes with a cap of 3: exactly 3 allowed.
- History persists across processes; a window stays full until a send ages out.
- Release from another process frees a slot; a double release is a no-op.
- Sliding window reopens at the right moment.
- Gap blocks at 30 min, allows at 91 min, and also blocks out-of-order timestamps.
- Leads are independent.
- A stale lock from a crashed worker is cleared.
- Invalid input throws.

**Limits**
- Local filesystem only. `mkdir` atomicity doesn't hold on NFS.
- I ran the tests on Node v24 locally. The code uses only APIs that exist in Node 22, but I did not run it on Node 22.
- The stale-lock breaker has a tiny theoretical race if two workers both detect a stale lock at the same instant. The lock is held for milliseconds, so I judged it negligible.
