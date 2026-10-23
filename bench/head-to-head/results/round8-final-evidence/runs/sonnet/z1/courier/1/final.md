`bot.mjs` is written and passes my checks. It exports `decide`, `recordDismissal` and `optOut`, needs no dependencies, and sends nothing. The test script is in `/tmp/gt`, outside the project.

**Rules in `decide`.** It returns `{ send: false, reason }` unless every rule passes. Any error or doubt also means no send.
- **Kill switch:** it never sends unless `flags.proactiveEnabled` is exactly `true`.
- **Consent:** it needs `consents.marketing === true`. A missing, empty or `false` value blocks the send. Your spec didn't say which purpose covers a check-in, so I picked `marketing`. It's the `CONSENT_PURPOSE` constant at the top of the file if that should differ.
- **Time zone:** it uses `deviceTimezone` first, then `timezone`. It skips values that are missing, invalid or placeholders (`UTC`, `Etc/UTC`, `GMT`). If neither is usable, it doesn't send, because quiet hours can't be checked. This also blocks users who really are in UTC.
- **Quiet hours:** it sends only between 09:00 and 20:00 in the user's local time.
- **Frequency:**
  - A candidate id is never delivered twice.
  - The same type needs at least 20 hours between sends, which also covers DST and travel.
  - All types together are capped at 2 per local day.
- **Opt-out:** `optOut` blocks that type permanently.
- **Dismissals:** the first three block the type for 3, 7 and 14 days. The fourth blocks it for good.

**State.** Each user gets one JSON file in `STATE_DIR`, with a lock file so worker processes don't collide. Writes are atomic, and a stale lock is cleared after 15 seconds. A corrupt state file also blocks sending rather than resetting a user's opt-outs.

**Checks run.**
- **Rules:** I tested each rule above, including the dismissal and opt-out paths and that other types stay unaffected.
- **Concurrency:** 12 separate processes decided for the same user at once, and exactly one sent.
- **Restart:** a fresh process remembered an earlier send.

**Choices to confirm.** The numbers (hours, caps, backoff days) are my choices, not from your spec, and they are constants at the top of the file. I applied the consent, quiet-hours and frequency rules to every type, not just `checkin`. I did not use `createdAt`, so a brand-new user can get a check-in on signup day.
