`bot.mjs` is written in the current folder. It exports `decide`, `recordDismissal` and `optOut`, and it needs no dependencies. The functional test and a 20-process race both passed, and the race also covered the restart check (a later process still saw the stored state).

The tests ran against the real `STATE_DIR` code paths with fake users. Nothing was sent. The test scripts are in `/tmp/bt`, outside the project.

`decide` returns `{ send: false, reason }` unless every rule below passes:
- **Kill switch:** it sends only when `flags.proactiveEnabled === true`. A missing flag counts as off, so it fails closed.
- **Consent:** it needs `consents.marketing === true`. A missing or empty `consents` means no. I treated the check-in as a marketing-style nudge. If your legal basis differs, change the consent key on the `consents.marketing` line in `decide`.
- **Time zone:** it uses `deviceTimezone` first, then the saved `timezone` if that isn't the "UTC" placeholder. If neither is usable, it doesn't send.
- **Quiet hours:** it sends only between 09:00 and 20:00 in the user's local time.
- **Opt-out:** `optOut` is permanent and applies per type.
- **Dismissals:** after one dismissal the type pauses for 2 days. After two it pauses for 7 days, and after three or more for 30 days.
- **Frequency:** at most one of each type per local day, a gap of at least 20 hours between two of the same type, and at most 2 proactive notifications per user per day across all types. The same `candidate.id` is never delivered twice.

State is stored as one JSON file per user in `STATE_DIR`, so it survives a restart. If `STATE_DIR` isn't set, it falls back to a `.state` folder next to `bot.mjs`. Each user file is guarded by a lock directory. Writes go to a temporary file and are renamed into place, and a lock left by a crashed process is cleared after 15 seconds.

In the race test, 20 processes called `decide` for the same user at once, and exactly one got `true`.

I didn't read the Courier skill's reference pages. The task was only the decision gate, so none of the Courier SDK calls are used.
