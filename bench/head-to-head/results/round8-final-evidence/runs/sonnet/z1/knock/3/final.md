`bot.mjs` is written in the current folder. It uses only Node built-ins, so `package.json` is unchanged. I tested it with 12 parallel processes and a fresh process after a restart, and all checks passed. Nothing is actually sent.

`decide` sends only if every one of these holds. Otherwise it returns `send: false` with a plain-sentence reason:
- **Kill switch:** `flags.proactiveEnabled` must be exactly `true`. A missing flag counts as off.
- **Consent:** `consents.marketing` must be `true`. Missing, empty or false means no. I treated the check-in as a marketing-type nudge, which is my assumption. If your consent screen has a different purpose key for it, change that one line.
- **Time zone:** it uses `deviceTimezone` first because it is the freshest, then `timezone`. The placeholder "UTC", invalid zones and missing values count as unknown, and unknown means no send.
- **Quiet hours:** it sends only between 09:00 and 20:00 in the user's local time.
- **Opt-out:** after `optOut`, that type is never sent to that user. Other types are unaffected.
- **Dismissal backoff:** after `recordDismissal`, that type is paused for 1, 3, 7, 14 and then 30 days as dismissals accumulate within 60 days. Older dismissals expire.
- **Frequency caps:**
  - A type is sent at most once per local day, and at least 20 hours apart.
  - Any two notifications are at least 2 hours apart.
  - A user gets at most 3 notifications per local day.
- **Duplicates:** a candidate id that was already delivered is not sent again.
- **Fail closed:** missing STATE_DIR, unreadable state or a lock timeout all mean no send.

Each user's state is one JSON file in `STATE_DIR`, written atomically and guarded by a lock file. Concurrent workers therefore can't double-send or lose an opt-out, and state survives a restart.

The tests covered the following:
- the kill switch and consent cases
- the "UTC" placeholder, the device-zone fallback and an invalid zone
- quiet hours
- the once-per-day cap and next-day sending
- dismissal backoff
- opt-out
- 12 parallel processes racing on one user (exactly 1 sent)
- a fresh process after restart still remembering an earlier send

I did not use `createdAt`, so a brand-new account can get a check-in as soon as the other rules allow. I can add a 24-hour hold after signup if you want one.

The test script is in `/tmp/t1`, outside the project.
