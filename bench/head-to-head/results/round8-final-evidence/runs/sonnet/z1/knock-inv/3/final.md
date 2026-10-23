`bot.mjs` is written in the current folder, and my check script passes. It has no dependencies, so `package.json` is unchanged. The check script is `/tmp/bot-check/check.mjs`, outside the project.

**What `decide` does.** It returns `send: false` with a plain reason if any of these fail. It checks them in this order, and applies them to every candidate type, not just `checkin`:
- **Kill switch:** `flags.proactiveEnabled` must be exactly `true`.
- **Consent:** `consents.marketing` must be `true`. Missing or empty consents count as no consent. I chose `marketing` because it was the closest purpose to a nudge. Change this if your consent screen has a better fit.
- **Time zone:** it uses `deviceTimezone` first, then `timezone`. It ignores `UTC` or other placeholders and invalid names. If no real zone is left, it does not send, because quiet hours can't be checked.
- **New accounts:** nothing is sent in the first 24 hours after `createdAt`.
- **Quiet hours:** it only sends between 09:00 and 20:00 in the user's local time. Daylight-saving changes are handled.
- **Opt-out:** a type the user switched off stays off for good.
- **Duplicates:** a `candidate.id` that was already delivered is not sent again.
- **Dismissal wait:** after a swipe-away, that type waits 2 days. Each further dismissal doubles the wait, up to 30 days. The count resets after 60 days without a dismissal.
- **Daily caps:** at most 1 per type and 2 across all types, per local day.

**State.**
- **Storage:** each user has a JSON file in `STATE_DIR`, so state survives a restart.
- **Concurrency:** a per-user lock between worker processes means only one can deliver to the same user. Writes are atomic.
- **Errors:** if the state can't be read or the lock can't be taken, `decide` returns `send: false` and never sends by mistake. `recordDismissal` and `optOut` throw instead, so a lost opt-out is never silent.

**What I checked.** The script covers each rule above, a daylight-saving boundary, and 12 separate processes racing for the same user, which produced exactly one send. A fresh process afterwards still blocked a second send. My first run failed on one test case I had written wrongly. A user with no zone at all correctly gets no send, and I corrected the case.

**Not covered.**
- A lock left by a crashed worker is treated as abandoned after 10 seconds. That cleanup is not tested.
- Nothing here notices when a user taps a notification. A user who engages keeps the dismissal wait until the 60-day reset.
