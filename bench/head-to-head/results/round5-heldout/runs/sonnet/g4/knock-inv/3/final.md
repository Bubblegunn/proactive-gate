`bot.mjs` is written and tested. It exports `reserve` and `release`, uses no dependencies, and runs on Node 22.

**How it works**
- **Storage:** history lives in `STATE_DIR`, one JSON file per lead. The directory is created if it is missing.
- **Locking:** each lead has an atomic `mkdir` lock, and the history file is written with a temp file plus rename. Every worker reads the same history, and it survives restarts. A lock left behind by a crashed worker is cleared after 15 seconds.
- **Window:** it is rolling. A slot counts for the `windowHours` before `now`, so a lead can't get a burst right after a fixed block resets.
- **What counts:** a reservation counts from the moment it is granted, so workers racing for the same lead see each other.
- **Release:** `release(id)` removes the slot entirely, so it no longer counts toward the window or the minimum gap. Releasing an unknown or already-released id does nothing. The lead's key is part of the id, so any worker can release it.
- **Reason codes:** `window_limit` and `min_gap`, plus `invalid_request` for bad input. It checks the window first, then the gap.
- **Clock differences:** the gap check ignores direction, so a slot slightly ahead of `now` still counts as too close. This covers small differences between worker clocks.
- **Corrupt history:** a corrupt history file makes `reserve` throw instead of allowing a send.
- **Pruning:** entries are only dropped after 30 days or after the call's window or gap, whichever is longest. Calls with different limits therefore still see the history they need.

**Tests I ran**
- Gap block: a reservation 5 minutes after another returned `min_gap`.
- Window block: a third reservation within the window returned `window_limit`.
- Release: after releasing a slot, the next reservation was allowed.
- Rolling window: after the window had passed, a new reservation was allowed.
- Concurrency: 12 separate processes asked for the same lead with a limit of 3. Exactly 3 were allowed.

Nothing was sent.

I didn't write a `.test` file. The checks ran from a throwaway script in `/tmp`.
