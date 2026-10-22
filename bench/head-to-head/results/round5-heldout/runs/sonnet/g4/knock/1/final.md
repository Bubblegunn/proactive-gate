I wrote `bot.mjs`. A test with 12 processes racing for the same lead gave exactly 3 slots and 9 denials. I haven't tested how a released slot behaves when a different process releases it. Nothing was sent.

**How it works**
- **Storage:** history is one JSON file per lead in `STATE_DIR`, created if missing. It survives restarts and every worker reads the same files.
- **Locking:** each lead has its own lock. A lock left behind by a crashed worker is cleared after 10 seconds.
- **Releasing:** the reservation id encodes the lead, so `release` works from any process. Releasing an unknown or already-released id does nothing.

**What counts toward the limits**
- Only live reservations count. Denied attempts are not recorded, so repeated tries don't extend a lead's wait.
- A released slot is deleted, since the lead never received that message.
- The window slides. A slot counts for `windowHours` after it was reserved, rather than the day resetting at a fixed time.
- The minimum gap is checked against every live reservation, in both directions. Workers' clocks can differ slightly, so a reservation stamped a little in the future still blocks.
- The reason codes are `window_limit` and `min_gap`. If both apply, it returns `window_limit`, because that takes longer to clear.
- Entries older than 30 days are dropped.

**Checks run**
- In a single-process run, the gap denial, the window denial, and a slot freed by `release` all behaved as intended, and an old slot slid out of the window.
- I ran no tests for stale-lock recovery or a crash mid-write.
