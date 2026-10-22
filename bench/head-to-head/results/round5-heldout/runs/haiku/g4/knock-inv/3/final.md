`bot.mjs` is written at `work/knock-inv-g4-3/bot.mjs`. All 11 test groups pass. Nothing was sent, and I did not commit.

**How it behaves**

- **Storage:** One JSON file per lead under `$STATE_DIR/leads/`. Writes go to a temp file and are then renamed into place. A `mkdir`-based lock per lead serializes the read-modify-write across processes. The lock is cleared after 10 s if its holder crashed.
- **What counts:** A reservation counts from the moment it is granted until `release()` removes it. Denied calls never count, so retrying a blocked lead does not push the gap forward. A slot whose worker crashed without releasing still counts, because the message may already have gone out.
- **Window:** Sliding. A send stops counting once it is older than `windowHours`. This is what the recipient experiences; a fixed window would allow bursts at the boundary.
- **Limits:** The window cap is checked first (`window_limit_reached`), then the minimum gap from the most recent counted send (`min_gap_not_elapsed`).
- **Scope:** History is keyed by lead only, not by campaign. A send from one campaign counts against another campaign's limits for the same lead.
- **Release:** Works from any process, since the id carries the lead key. Releasing twice, or releasing an unknown or malformed id, returns `false` and changes nothing.
- **Retention:** History is kept for the longest `windowHours` or `minGapMinutes` any caller has used so far. If a later call uses a longer window, history already pruned under a shorter one is gone.

**Tests** (`/tmp/bot-check/test.mjs`, outside the project; they use a temp `STATE_DIR`)

- Window cap with pending reservations counting.
- Min gap, and that denied attempts do not reset it.
- Sliding window expiry.
- Release frees the slot, is idempotent, and lifts the gap.
- Per-call limits.
- A stale lock is cleared.
- History survives a restart.
- 12 processes × 5 calls at the same instant: exactly 3 allowed under a cap of 3, and exactly 1 allowed under a 90-minute gap.
- Input validation, and `STATE_DIR` is required.

**Limits to know about**

- The stale-lock clearing has a narrow race: two workers that both see the same lock as stale at once could both clear it. It only matters if a lock is held for more than 10 s, which the code does not normally do.
- I ran on Node 24.13.0. The code uses only Node 22-compatible APIs, but I did not run it on Node 22.
- I did not create or touch your real `STATE_DIR`. The code creates `leads/` and `locks/` inside it on first use.
