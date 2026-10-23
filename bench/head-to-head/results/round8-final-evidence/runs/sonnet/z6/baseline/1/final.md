`bot.mjs` is written, and I tested it. All my checks pass, including 6 worker processes making 60 decisions for one user at once. Exactly 3 were delivered.

- **`decide`** applies the rules in this order: consent, then quiet hours, then the daily cap.
  - **Quiet hours:** 22:00 is blocked and 08:00 is allowed.
  - **Daily cap:** it is counted per local calendar day, using the user's timezone at decision time (checked with Istanbul and Los Angeles).
  - **Consent:** only `consent === true` counts.
  - **Retries:** a retry of an already-delivered notification returns `{ send: true }` and is not counted again.
- **State** is one append-only log per user under `STATE_DIR`, guarded by a lock directory. It survives a restart. It ignores a torn last line, and a lock left by a dead process is cleared.
- **`whyNotReceived`** reads that log and returns entries in the order they were considered, over `[from, to)`.
  - **Rule codes:** `NO_CONSENT`, `QUIET_HOURS` and `DAILY_CAP`.
  - **`availableAt`:** it is `null` for a consent block. For quiet hours and the cap it is the next 08:00 local time.
  - **`text`:** one readable sentence with local times.
- **`dryRun`** replays the events in time order against the candidate policy, using only in-memory state. It never reads or writes `STATE_DIR`, and I checked that no files change. With the current policy, a 24-hour sample gave 3 delivered and 21 blocked. With no quiet hours and no cap, it gave 24 delivered.

**Assumptions I made** (the spec doesn't settle these):
- A blocked notification that is retried later is decided again, and each attempt gets its own log entry.
- A quiet-hours window with `start == end` is treated as empty.
- `dryRun` applies consent rules as well as the policy.
- A notification blocked on an invalid timezone throws an error rather than being sent.

There are no new dependencies, so `package.json` is unchanged. My test scripts are in `/tmp/gt`, outside the project.
