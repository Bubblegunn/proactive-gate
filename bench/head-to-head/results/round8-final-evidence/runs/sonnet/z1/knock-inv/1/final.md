`bot.mjs` is written in the current folder and passes my checks. It needs no dependencies, so `package.json` is unchanged. Nothing is actually sent.

**What I tested** (throwaway script in `/tmp`, not in the project):
- A user gets one check-in per local day, and can get another the next day.
- It does not send when `proactiveEnabled` is false.
- It does not send without `consents.marketing === true`. Missing or empty consents count as no.
- It does not send outside 09:00–20:00 local time.
- Time zone handling works as described under Rules below, including a placeholder "UTC" zone with a Tokyo device.
- A dismissal pauses the type, and the pause ends on schedule.
- After an opt-out the type never sends again, even 400 days later.
- Eight worker processes racing for the same user produced exactly one send. A fresh process afterwards saw the earlier send.

**Rules**, using the Knock skill's implementation guidance (preference hierarchy, quiet hours, frequency caps, consent):
- **Kill switch:** nothing sends when `flags.proactiveEnabled` isn't `true`.
- **Opt-out:** `optOut` is permanent per user and type, and `decide` checks it before anything else that touches saved state.
- **Consent:** `decide` requires `consents.marketing === true` for every type. I treated the check-in as engagement messaging. If you consider it transactional, remove that check in `decide`.
- **Time zone:** the device zone is used if valid. Otherwise the signup zone is used, unless it is missing, invalid or the "UTC" placeholder. With no usable zone it doesn't send, because it can't check quiet hours.
- **Quiet hours:** sends only between 09:00 and 20:00 in the user's local time.
- **Frequency:** at most one per type per local day, and at most two proactive notifications of any type per day.
- **Dismissals:** the pause after a swipe doubles with each dismissal (2, 4, 8 … days, capped at 30). Dismissals older than 90 days stop counting.
- **Concurrency and restarts:** state lives in `STATE_DIR` as one file per user, named by a hash of the user id. A lock directory per user keeps workers from overlapping, and a lock older than 10 seconds is taken over. Writes go to a temp file and are then renamed, so a crash can't leave a half-written file.

The consent rule and the limits are constants at the top of the file, so they are easy to change.
