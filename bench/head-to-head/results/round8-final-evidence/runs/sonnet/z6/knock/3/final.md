`bot.mjs` is written and checked. I'm doing a last wrap-up now; no more edits are planned.

**What's in it** (`bot.mjs`, no dependencies, so `package.json` is unchanged):
- **`decide`** blocks in this order: no consent, then quiet hours (22:00–08:00 local, 22:00 is quiet and 08:00 is not), then the cap of 3 delivered per local calendar day. Blocked notifications don't count toward the cap.
- **Repeat calls:** deciding the same notification id again for the same user returns the first answer and isn't counted twice.
- **State** lives under `STATE_DIR` as one append-only log per user. It's fsynced and guarded by a per-user lock directory, so several workers can run at once and it survives a restart.
- **`whyNotReceived`** reads that log and returns the entries with `from <= at < to`, in the order they were decided. Rule codes are `NO_CONSENT`, `QUIET_HOURS` and `DAILY_CAP`.
- **`availableAt`:** it is `null` for no consent. For quiet hours it is the next local 08:00. For the cap it is the next local midnight, pushed to 08:00 because midnight is quiet.
- **`text`** is one sentence with the local time and timezone.
- **`dryRun`** uses the same rule code as `decide` but runs only in memory. It never touches `STATE_DIR`. It sorts events by time and keeps each user's consent. A `null` quiet-hours or cap setting turns that rule off.

**What I checked** (scratch tests in `/tmp/botcheck`, not in the repo):
- **Boundaries:** 07:59 is blocked, 08:00 is delivered, 21:59 is delivered, 22:00 is blocked. The 4th notification of a day is blocked, and the cap resets at local midnight.
- **Other `decide` checks:** repeated notification ids don't double-count, and a user without consent is blocked.
- **`whyNotReceived`:** order, the half-open range, `availableAt` and the text all came out as expected.
- **`dryRun`:** it returned different numbers for different policies, and the stored log was identical before and after.
- **Concurrency:** 6 processes ran at the same time on one user, 120 decisions in total, and exactly 3 were delivered. A 7th process started afterwards still saw those 3 and delivered none.

**Choices to confirm:**
- **`consent`:** anything other than boolean `true` counts as no consent.
- **Invalid timezone:** an invalid timezone throws an error instead of guessing.
- **`dryRun` repeats:** it dedupes repeated user and notification pairs the same way `decide` does.
- **Log growth:** the log grows without pruning and the cap check re-reads the user's whole file, so long-lived users may need trimming later.
