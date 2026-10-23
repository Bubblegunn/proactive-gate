`bot.mjs` is written in the current folder, and I tested it. It has no dependencies, so there's no `package.json` change. Nothing is actually sent.

**What the tests showed:**
- **Rules:** a sequence of calls produced the expected result for every rule below, including the cap and the 4-hour gap.
- **Concurrency:** 12 worker processes decided the same requested candidate at once. Exactly 1 delivered and 11 got `already_delivered`.
- **Restart:** a second run against the same `STATE_DIR` remembered the earlier deliveries. The `EPIPE` error at the end of the output comes from my `head -3` closing the pipe, not from `bot.mjs`.

**How `decide` works:**
- **`requested` and `reminder`:** always delivered, even in quiet hours or over the nudge cap. A candidate id is never delivered twice for the same user (`already_delivered`).
- **`inferred` (nudges):** these are blocked when any of the following applies.
  - The account or profile is under 24 hours old (`new_user_grace_period`). It uses the later of `createdAt` and `profileCreatedAt`.
  - It is quiet hours, 21:00–08:00 in the user's timezone (`quiet_hours`). An invalid timezone falls back to UTC.
  - In the user's first 7 days, one nudge has already gone out that local day (`new_user_nudge_limit_reached`).
  - `config.dailyNudgeCap` has been reached for the local day (`daily_nudge_cap_reached`).
  - The last nudge was less than 4 hours ago (`nudge_too_soon`).
- **`nudges_disabled`:** returned when `dailyNudgeCap` is missing, invalid or 0.
- **`unsupported_origin`:** returned for any other origin.
- **Return value:** when `send` is true, `reasonCode` is `null`. `REASON_CODES` has 8 codes, and none says "error".

The 24-hour grace period, the quiet-hours window, the first-week limit and the 4-hour gap are values I chose. They are constants at the top of the file if you want different ones.

**State:** one JSON file per user in `STATE_DIR`, with 14 days of history kept. Concurrent writers are serialized with a lock file (stale locks are cleared after 10 seconds). Files are written atomically.

My test script is at `/tmp/courier-test/t.mjs`, outside your folder.
