`bot.mjs` is written in the current folder and works in my checks. It has no dependencies, so `package.json` is unchanged.

**Rules in `decide`**
- It checks consent first, then quiet hours, then the daily cap. Everything is judged on the user's local clock, including across DST changes.
- The rule codes are `NO_CONSENT`, `QUIET_HOURS` and `DAILY_CAP`.
- Only `consent === true` counts as consent.
- An invalid timezone blocks the notification with the code `INVALID_TIMEZONE`.

**State**
- Each user has an append-only file under `STATE_DIR`, guarded by a lock that works across processes. A dead lock holder is cleared after 10 seconds.
- Every decision is logged, delivered or blocked, and each write is flushed to disk. A write torn by a crash is skipped on read.

**`whyNotReceived`**
- It returns the logged decisions in `[from, to)`, in the order they were made.
- `availableAt` is the next 08:00 local time for quiet hours. For the cap it is the next local midnight, moved to 08:00 if that falls in quiet hours. It is `null` for no consent.
- `text` is one sentence with the local time and timezone.

**`dryRun`**
- It sorts the events by time and applies the candidate policy with in-memory counters per user. It never reads or writes `STATE_DIR`.
- A `null` policy field disables that rule. A quiet window where start equals end is treated as empty.

**What I checked**
- I ran 6 worker processes at once, each making 10 decisions for the same user on the same day. Exactly 3 were delivered, and the 60 decisions were all logged.
- A separate process then read the same state: it saw the 3 deliveries and blocked 23:00 and 07:00 as quiet hours, on the DST-change day in `America/New_York`.
- The decision after quiet hours ended, at 08:00, was delivered. A user without consent was blocked, and an unknown user returned `[]`.
- Three `dryRun` policies gave the expected counts, and the log stayed at 63 lines for the main user (60 from the workers plus the 3 later decisions), so `dryRun` left state alone.
- I did not test recovery from a stale lock, or a torn write left by a crash.

**Behaviour to know**
- Each call to `decide` is a separate decision, even with the same notification id. A held notification that is retried after `availableAt` is judged again, but a retry of one already delivered would count twice toward the cap.
- If you want retries of delivered notifications to be ignored, say so and I'll add it.
