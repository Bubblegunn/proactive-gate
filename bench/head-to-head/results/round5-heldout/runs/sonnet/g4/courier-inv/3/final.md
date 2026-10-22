`bot.mjs` is written and works. I checked it with 12 concurrent processes and a sequential test. Nothing was sent, and the Courier skill had nothing to contribute because this is a local limiter, not a Courier send.

**How it behaves**
- **Storage:** there is one JSON file per lead in `STATE_DIR`, which is created if missing. A lock keeps workers from overwriting each other, and a lock left behind by a crashed process is cleared after 30 seconds.
- **Window:** it is rolling. A lead never gets more than `maxPerWindow` messages in any span of `windowHours`, so there is no midnight reset that would allow a burst.
- **Minimum gap:** it is measured from the nearest active reservation, in either direction, so small clock differences between callers can't slip a message through.
- **Release:** `release` removes the slot straight away, so a message the lead never received doesn't count. The reservation id contains the lead id, so any worker can release it. Releasing an unknown or already-released id does nothing.
- **Reason codes:** `window_limit` and `min_gap`. If both limits apply, `window_limit` is reported.
- **Retention:** entries older than 31 days are dropped.
- **Bad input:** a missing `STATE_DIR` or invalid arguments throw an error instead of silently allowing a send.

**What I tested**
- **Concurrency:** 12 processes reserved for the same lead with a limit of 3. Exactly 3 were allowed and 9 got `window_limit`.
- **Sequence:**
  - A second send 30 minutes after the first returned `min_gap`.
  - A send at 2 hours was allowed, and one at 4 hours was blocked by `window_limit`.
  - After releasing the 2-hour slot, the 4-hour send was allowed.
  - After 25 hours the first reservation aged out of the window and a new send was allowed.

I didn't test the stale-lock cleanup.
