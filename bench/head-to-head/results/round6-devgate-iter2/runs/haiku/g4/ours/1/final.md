`bot.mjs` is written in the work directory and passes the checks I ran. Nothing was sent, and I did not commit.

**Behaviour**
- **What counts:** a slot counts from `reserve` until `release`. Refused requests never count, because the lead gets nothing from them. If a worker crashes after reserving and never releases, the slot stays used. That errs toward fewer messages, which protects the sender reputation.
- **Window:** a sliding window. A send falls out of the window exactly `windowHours` after it was made. The window includes its start and excludes its end.
- **Min gap:** the gap is measured from the most recent counted send. Exactly `minGapMinutes` later is allowed.
- **Reasons:** two codes, `window_limit` (cap reached) and `min_gap` (too soon after the last send). A refusal returns `reservationId: null`.
- **Release:** the reservation id starts with the lead's hash, so any worker can find the record. Releasing an unknown or already-released id returns `{ released: false }` and changes nothing.
- **Limits per call:** `maxPerWindow`, `windowHours` and `minGapMinutes` are read on every call. History is kept for the longest window or gap any caller has used for that lead.

**Concurrency and storage**
- `STATE_DIR` is read on every call and created if missing. Each lead has one JSON file under `users/`.
- A `mkdir` lock per lead serializes read-modify-write. Different leads never wait on each other.
- A lock older than 5 s is treated as left by a crashed worker and broken. Waiting retries every 5–10 ms.
- Writes go to a temp file and are renamed into place.
- A corrupt record throws, so the caller fails closed and does not send.

**Not built, because the request did not ask:** quiet hours, time zones, opt-out and consent. The limiter has no fields for them. Those checks belong in the caller or in a separate gate.

**Checks run** (in a temp `STATE_DIR`, using real child processes):
- 12 concurrent workers on one lead: exactly 3 allowed, 9 refused with `window_limit`.
- Release from another process frees one slot; a second release is a no-op; the freed slot can be reused.
- Min gap: 60 min later refused with `min_gap`; exactly 90 min later allowed.
- Sends older than 24 h stop counting.
- A fresh process sees earlier sends: 3 allowed, the 4th refused.
- A per-call `maxPerWindow` of 1 is applied to existing history.
- Invalid input throws `TypeError`.

My first run had a test-script typo, and one persistence check was my own mistake in its expected values. I fixed both and reran; the limiter code itself did not change.

**Known limits**
- The stale-lock break is not fully race-free. If two workers both see the same stale lock at the same moment, one can remove the other's fresh lock. The 5 s threshold makes this very unlikely; I did not add a fencing token.
- Clocks must roughly agree. A reservation stamped in the future blocks the gap check until that time passes.
