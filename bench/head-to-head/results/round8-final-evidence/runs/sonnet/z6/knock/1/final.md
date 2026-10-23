`bot.mjs` is written and works. It exports `decide`, `whyNotReceived` and `dryRun`, and it needs no dependencies. I ran it with real worker processes and everything below matched.

- **Concurrency and restart:** six processes ran at once for one user, five attempts each, and exactly 3 notifications were delivered. A new process afterwards delivered none, because the state persisted. No lock files were left behind.
- **Rules:**
  - 22:30 local is blocked as quiet hours.
  - 08:00 local is allowed, and 21:59:59 is allowed.
  - The 4th notification of a day is blocked by the cap.
  - A user without consent is blocked.
- **`whyNotReceived`:** it returns one entry per decision in the order considered. Each entry has a rule code (`NO_CONSENT`, `QUIET_HOURS` or `DAILY_CAP`), the earliest time it could have been delivered, and a sentence for the customer. `availableAt` is `null` for no consent.
- **`availableAt` and DST:** `availableAt` was correct across the November 1 clock change in New York (08:00 local became 13:00Z).
- **`dryRun`:** it replays the events in memory only and never touches `STATE_DIR`. Replaying a week of events with no quiet hours and no cap delivered all 6. The current policy delivered 3 and blocked 3. A 23:00–05:00 window with a cap of 2 delivered 2 and blocked 4.

Where your spec was silent, I chose the following:
- **Rule order:** consent is checked first, then quiet hours, then the cap.
- **Retries:** if `decide` is called again for a notification that was already delivered, it returns `send: true` without counting it a second time.
- **`dryRun` counts:** it counts a repeated delivered event once and treats it as delivered. It starts from an empty state, so it ignores what was really delivered. It treats a quiet window where start equals end as no quiet hours.
- **Consent:** only `consent === true` counts as consent.

I haven't tested a timezone where midnight itself doesn't exist because of DST.

My test scripts are in `/tmp/botcheck`, outside the project folder.
