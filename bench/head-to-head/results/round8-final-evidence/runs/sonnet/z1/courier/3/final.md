`bot.mjs` is written in the current folder. It has no dependencies, so `package.json` is unchanged. I tested it with a script in `/tmp`, and all checks passed. They covered the rules below, a restart (the state files persisted), and 12 processes racing on one user (exactly one got a send).

What `decide` checks, in order. Every rule that blocks a send returns a plain-sentence reason, and a send returns `reason: null`:
- **Kill switch:** `proactiveEnabled` must be `true`.
- **Consent:** it needs `consents.marketing === true`. Missing, empty or false consents mean no send.
- **Time zone:** it uses `deviceTimezone` first, then `timezone`. It ignores missing, invalid and placeholder values such as "UTC". If the zone is unknown, it doesn't send, because it can't check quiet hours.
- **Quiet hours:** it only sends from 9:00 to 19:59 in the user's local time. DST is handled by `Intl`.
- **Opt-out:** `optOut` is permanent for that type and survives a restart.
- **Dismissal backoff:** after one dismissal the type pauses for 3 days, after two for 7 days, and after three or more for 30 days. Dismissals older than 60 days are forgotten.
- **Frequency:** at most 1 per type and 2 per user per local day. There must be at least 3 hours between any two sends.
- **Duplicates:** a candidate id that was already delivered is not sent again.

State is one JSON file per user in `STATE_DIR`, written atomically. Each user has a lock file, so the check and the record of a send happen together across worker processes. If state can't be read or locked, `decide` sends nothing.

Decisions to confirm:
- **Consent key:** you didn't say which consent purpose covers a check-in, so I used `marketing` and apply it to all notification types. If check-ins should fall under another purpose, change `REQUIRED_CONSENT`.
- **Limits:** the hours window, the frequency caps and the backoff lengths are my choices. They are constants at the top of the file.
- **Not used:** `createdAt` isn't used.
- **Dismissal count:** it never resets after a user engages, because the app doesn't tell the gate about engagement.
