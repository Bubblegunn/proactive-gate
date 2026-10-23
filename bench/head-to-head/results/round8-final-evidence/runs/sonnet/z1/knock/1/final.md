`bot.mjs` is written and exports `decide`, `recordDismissal` and `optOut`. Six tests in `bot.test.mjs` pass, and nothing is actually sent. It needs no dependencies, so `package.json` is unchanged.

The tests cover:
- the once-per-day limit
- the emergency switch
- missing, false and wrong consent
- quiet hours and time zone choice
- permanent per-type opt-out
- dismissal backoff
- 12 separate processes racing on one user, where exactly one sends

Each decision follows these rules:
- **Emergency switch:** `decide` sends nothing unless `flags.proactiveEnabled` is exactly `true`.
- **Consent:** it sends only if `consents.marketing === true`. A missing, empty or false value blocks it, and so does `consents[type] === false`. I treated the check-in as marketing-type consent, since your `consents` examples don't name a notification purpose. Change `REQUIRED_CONSENT` if you want a different key.
- **Opt-out:** `optOut` is stored per user and per type and never expires. Opting out of "checkin" doesn't affect "tip".
- **Dismissals:** after the 1st, 2nd and 3rd dismissal of a type, that type waits 3, 7 and 30 days. A 4th dismissal pauses it. Dismissals older than 90 days are forgotten.
- **Time zone:** it uses `deviceTimezone` first, then `timezone`. A missing, invalid or "UTC"-style placeholder zone counts as unknown, and it then sends nothing instead of guessing.
- **Allowed hours:** it sends only between 09:00 and 20:00 in the user's local time.
- **Frequency:** at most one per type per local day, at least 12 hours between two of the same type, and at most 2 notifications of any type in 24 hours. It also refuses a repeated `candidate.id`.
- **Failures:** if the state file can't be read or locked, `decide` returns `send: false` with a reason.

The state is kept as one JSON file per user in `STATE_DIR`. Each file is written atomically and fsynced, and a per-user lock directory makes the check-and-record step safe across workers. A lock left behind by a crashed worker is removed after 30 seconds.

The thresholds (hours, gaps, backoff days, the 2-per-day cap) are my own picks, kept as constants at the top of `bot.mjs`.
