`bot.mjs` is written, and all 7 tests in `bot.test.mjs` pass. I ran them on Node v24.13 here. I didn't run them on Node 22. `bot.mjs` has no dependencies and `package.json` is unchanged.

The tests cover consent, the quiet-hours edges (21:59:59 is allowed, 22:00 is blocked, 07:59:59 is blocked, 08:00 is allowed), and the daily cap resetting at local midnight. They also cover a daylight-saving fall-back day, the `from`/`to` range rules, `dryRun` writing nothing to `STATE_DIR`, and 8 worker processes sharing one user. Those 8 processes made 48 decisions between them and exactly 3 were sent.

- **`decide`:** Checks consent first, then quiet hours, then the daily cap, and the first rule that stops a notification is the one reported. Every decision, sent or blocked, is appended to a per-user file in `STATE_DIR`. A lock per user lets several workers share that file. Anything other than `consent === true` counts as no consent.
- **`whyNotReceived`:** Reads that log and returns the entries in the order they were considered, with the six fields you specified. The `ruleCode` values are `NO_CONSENT`, `QUIET_HOURS`, `DAILY_CAP` and `UNKNOWN_TIMEZONE`. The `text` is one sentence with the customer's local time and time zone. `availableAt` is the end of quiet hours or the start of the next allowed day. It is null for consent and time-zone blocks, since those can't be resolved by waiting.
- **`dryRun`:** Replays the events in time order against the candidate policy and returns `{ delivered, blocked }`. It doesn't read or write `STATE_DIR`, so it can't affect real decisions. Caps are counted only from the events you pass in.

Choices I made that you didn't specify:
- A notification is blocked from 22:00 up to, but not including, 08:00.
- A quiet-hours window where start equals end is treated as no quiet hours, not a 24-hour block.
- A user with a missing or invalid time zone is blocked with `UNKNOWN_TIMEZONE`.
- `decide` doesn't deduplicate on notification id. A retry of the same id uses another slot of the cap. That keeps the "at most 3" limit safe, but a worker that crashes and retries could use up a slot.

The lock directory is taken over if it's older than 30 seconds, which is what recovers from a crashed worker. If two workers take over the same dead lock at the same moment, they could both enter. That is unlikely, because the locked section takes milliseconds.
