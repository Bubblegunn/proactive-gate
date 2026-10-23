`bot.mjs` is written in the current folder and exports `decide`. I ran it with a test script and the results matched my intent. It has no dependencies and sends nothing. The EPIPE error at the end of the run is from my `head -2` closing the pipe, not from the bot.

**When it stays quiet** (`send: false`, empty `surfaces`, plain-sentence `reason`):
- The user is in a crisis.
- The insight has no key or invalid numbers, fewer than 5 data points, or confidence below 0.6.
- The same `candidate.id` was already delivered.
- The same finding (`insight.key`) was delivered in the last 14 days.
- Another message was delivered less than 2 hours ago.
- The user already got 3 messages today (their local day).
- The user mostly dismissed messages at this local hour, using at least 5 samples in `hourStats` and more dismissed than acted.

**When it sends:** `surfaces` is `["push","inApp"]` by default. It drops to `["inApp"]` when:
- the user is in focus mode,
- the local time is 22:00–08:00, or
- a push was already delivered that day (1 push per day).

Only messages that are shown get recorded, so quiet decisions don't use up the limits.

**State:** it lives in `$STATE_DIR/gate-state.json`, written atomically. If `STATE_DIR` isn't set, it uses `./.state`. Calls in one process are queued so they can't overwrite each other. Nothing guards against two separate processes sharing one `STATE_DIR`.

**Checked:**
- Every rule above gave the expected result, apart from the daily message limit, which my test didn't reach.
- A second run in a new process still saw the earlier deliveries, so state survives a restart.

**Your call:** the spec doesn't say what focus mode should do. I made it in-app only (no push), since an in-app item doesn't interrupt. If you want total silence in focus mode, say so and I'll change it.

The thresholds are constants at the top of the file.
