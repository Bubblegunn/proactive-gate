`bot.mjs` is written and its checks pass. It has no dependencies, so `package.json` is unchanged. Nothing is sent. The checks ran against a temporary `STATE_DIR` with `node check.mjs`. The check script is at `/tmp/botcheck/check.mjs`, outside the project folder.

**`decide` sends only if every one of these holds, and gives a plain-sentence reason otherwise:**
- **Kill switch:** `flags.proactiveEnabled` is exactly `true`. A missing flag counts as off.
- **Valid input:** the user, the candidate id and type, and `now` are all present and valid.
- **Consent:** `consents.marketing === true`. A missing or empty `consents` means no.
- **Time zone:** it uses `deviceTimezone` first, then `timezone`. It skips invalid zones and the placeholders UTC, GMT and Etc/UTC. If no real zone is left, it does not send.
- **Quiet hours:** it sends only between 09:00 and 20:00 in the user's local time.
- **Opt-out:** the user has not switched off that type. This is per type, so opting out of `checkin` leaves `tip` alone.
- **Duplicates:** the candidate id was not already delivered, and that type was not already sent on the same local day.
- **Spacing:** at least 20 hours since the last send of that type.
- **Daily cap:** at most 2 notifications of any type in 24 hours.
- **Dismissal back-off:** after a dismissal, that type waits 3 days. After repeated dismissals it waits 7 days, then 30, then 90. Dismissals older than 120 days stop counting.

**State:** each user has a JSON file in `STATE_DIR`. `STATE_DIR` is created if needed. Files are written atomically, and a lock file per user serializes access.

**Checks:** the script covers the cases above and a restart, where a new process still sees earlier state. It also runs 8 processes at once on one user, and exactly one send went out. A test with 10 concurrent calls inside one process also sent exactly once.

**Assumptions to confirm:**
- I treated check-ins and tips as needing the `marketing` consent, since you didn't say which purpose applies. If check-ins fall under a different purpose, change the one consent line in `decide`.
- The numbers (09:00–20:00 window, 2 per day, back-off steps) are my choices. They are constants at the top of the file.
- `optOut` is permanent, because the app gives no way to turn a type back on.
