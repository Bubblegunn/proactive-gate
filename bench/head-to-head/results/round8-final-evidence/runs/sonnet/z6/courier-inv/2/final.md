`bot.mjs` is written in the current folder. It exports `decide`, `whyNotReceived` and `dryRun` and has no dependencies, so `package.json` is unchanged. My test script passed on this machine, which runs Node 24, not Node 22. I did not run it on 22.

I did not use any Courier API or SDK features, because this is all local logic.

**What the test checked** (the script lives in `/tmp/gt`, outside the work folder):
- **Quiet hours:** 21:59:59 local is delivered, 22:00:00 is blocked, 07:59 is blocked and 08:00 is delivered.
- **Consent:** a user without consent is blocked.
- **Daily cap:** the 4th notification on one local day is blocked, and the next local day starts fresh.
- **Daylight saving:** a New York case around the November clock change gives the right answer.
- **Restart:** a fresh process, started after the decisions, read back the saved history in order and filtered it correctly by time range.
- **Concurrency:** 6 processes made 30 decisions for one user on one day. Exactly 3 were delivered.
- **Dry run:** `dryRun` left the state files byte-identical, and its counts matched hand calculations for three candidate policies.

**`decide`**
- A decision is blocked by the first rule that fails, checked in this order: `no_consent`, then `quiet_hours`, then `daily_cap`. A missing or invalid timezone is blocked with `invalid_timezone`.
- Only delivered notifications count toward the cap. Blocked ones do not use it up.
- Consent must be exactly `true`. The string `"false"` does not count as consent.
- Every decision, delivered or blocked, is saved with its rule code, the earliest time it could have been delivered, and the user's timezone. That history is what `whyNotReceived` reads.

**`whyNotReceived`**
- It returns decisions in the order they were made, filtered to `from` (inclusive) up to `to` (exclusive). It reads state and writes nothing.
- `availableAt` is the earliest time that would have passed both the quiet-hours and cap rules. For a cap block that lands in quiet hours, it is 08:00 the next day. It is `null` for a missing consent or an invalid timezone.
- `text` is one sentence in the customer's local time. For example: "...due at 2026-10-24 00:30 (Europe/Istanbul), which is inside the customer's quiet hours (22:00 to 08:00 local time); the earliest it could have been delivered was 2026-10-24 08:00 (Europe/Istanbul)."

**`dryRun`**
- It replays the events in time order against your candidate policy, keeping all counts in memory. It never touches `STATE_DIR`.
- Consent and timezone rules still apply. `quietHours: null` turns quiet hours off and `dailyCap: null` turns the cap off. A `dailyCap` of 0 blocks everything.
- Replay starts with an empty count for each user. Deliveries from before the first event in `events` are not counted toward the cap.

**State**
- It is one file per user under `STATE_DIR/users`. A lock is held while a decision is checked and saved, so parallel workers cannot exceed the cap. A lock left behind by a crashed worker is cleared after 10 seconds.
- The same notification id is not treated as a duplicate. Each `decide` call counts as a new decision, because I assumed repeated ids might be sent on purpose. Tell me if you want repeat sends of one id to be ignored.
