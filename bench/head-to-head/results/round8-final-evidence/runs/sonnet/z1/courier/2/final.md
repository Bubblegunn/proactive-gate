`bot.mjs` is written in the current folder with `decide`, `recordDismissal` and `optOut`. `node test.mjs` passes against it, including a test with 12 worker processes. No dependencies were needed, so `package.json` is unchanged. The file changed on disk after my last read (the system flagged it), and I haven't looked at the new content. The tests passed after my last edit, but I haven't re-run them since the flag.

`decide` sends only when all of these hold:
- **Kill switch:** `flags.proactiveEnabled` must be true.
- **Consent:** `consents.marketing` must be exactly true. A missing or empty `consents` means no send. This is my assumption, since you didn't say which purpose a check-in falls under. If check-ins should use a different consent key, change it in `decide`.
- **Opt-out:** `optOut` blocks that type permanently, and other types are unaffected. It survives a restart.
- **Local time:** it sends only between 09:00 and 20:00 in the user's own zone. It uses `deviceTimezone` first and falls back to the saved `timezone`. A missing, invalid or "UTC" zone is not trusted, so if no real zone is known it doesn't send.
- **Frequency:** at most one per type per local day and at most two notifications per day in total. It also keeps minimum gaps of 20 hours for the same type and 4 hours between any two.
- **Dismissals:** each dismissal of a type doubles the pause: 2 days, then 4, 8 and so on, up to 30. A dismissal older than 90 days is forgotten.
- **Repeats:** a candidate id is delivered at most once, so retries don't send it again.

If anything goes wrong, such as an unreadable state file or a missing `STATE_DIR`, `decide` returns `send: false`. Each user has one JSON file in `STATE_DIR`, updated under a lock file, so only one worker can send at a time.

`test.mjs` covers each rule above. In the concurrency test, 12 processes competing for the same user produced exactly one send. It also checks that an opt-out is still in effect in a fresh process.

All the limits (hours, gaps, caps, back-off) are constants at the top of `bot.mjs`, so they are easy to change.
