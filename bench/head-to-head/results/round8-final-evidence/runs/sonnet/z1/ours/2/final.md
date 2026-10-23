`bot.mjs` is written and exports `decide`, `recordDismissal` and `optOut`. It has no dependencies, so there is no `package.json` change. I ran a self-check in one process, and it passed. I did not test several worker processes running at once, and I did not test a restart in the middle of a run.

The self-check covered:
- A normal check-in is sent.
- The same message id sent twice gets the same answer and uses no extra budget.
- The daily cap, quiet hours, missing consent, missing time zone, the operations kill switch, a recent dismissal, a type opt-out and a different type for the same user each behave as intended.
- Four calls with the same message id at the same time all return `send: true`, and the cap was spent once.

**Rules `decide` applies**
- **Kill switch:** it holds unless `flags.proactiveEnabled` is exactly `true`.
- **Consent:** it holds unless `consents.marketing` is `true`. I used `marketing` because no consent purpose is named for check-ins and I did not want to invent one. If check-ins should use a different purpose, change that one line.
- **Opt-out:** it is stored per user and per type, and it beats every other rule.
- **Time zone:** it uses `deviceTimezone` first, then `timezone`. A missing, invalid or `"UTC"` zone holds the notification.
- **Retry times:** every hold that has a retry time returns it as `nextAllowedAt`, written in the user's local clock time with the zone name.
- **Redelivery:** a repeated message id returns `send: true` again and does not spend budget a second time. Held decisions are not remembered, so the same id can still be sent later.

**Numbers I chose**
- Quiet hours are 21:00 to 08:00 in the user's local time. 08:00 is allowed and 21:00 is not.
- After a swipe-away, that type is paused for 3 days.
- The cap is 1 notification per type per local day.
- The cap is 3 notifications per user per local day across all types.

These numbers are my choices, not part of the request, so change them if you want different limits.

**Not enforced:** body checks on the message text. `decide` only receives an id and a type, so there is no text to check.

State is written under `STATE_DIR`, which is read on every call and created if missing. Writes are atomic and the state files stay on disk across restarts.
