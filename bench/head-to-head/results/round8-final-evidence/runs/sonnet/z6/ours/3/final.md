`bot.mjs` is written in the current folder. It exports `decide`, `whyNotReceived` and `dryRun`, and has no dependencies.

I ran it against a temporary `STATE_DIR` with test scripts. Four worker processes sharing one `STATE_DIR` made 40 `decide` calls for one user on one day. Exactly 3 were delivered.

What I checked:
- **`decide`:** five notifications to one user in one day gave true, true, true, false, false. A quiet-hours instant and a no-consent user were both refused. The first call also confirmed one message is allowed.
- **Same notification id:** it gets the same answer and does not use up the cap again.
- **`whyNotReceived`:** it returned the delivered, cap-refused and quiet-hours entries in the order considered. The cap-refused and quiet-hours entries carried `availableAt` and a sentence with local clock time and zone.
- **`dryRun`:** for four sample events it gave 2 delivered and 2 blocked under the candidate policy, and 4 and 0 with no policy. It keeps its counts in memory only.

What I did not check: a worker restart. State is written to files in `STATE_DIR`, so it should survive one, but I did not test it. I also did not test DST edges or an invalid zone.

How it behaves:
- **Check order:** consent, then a valid zone, then quiet hours, then the daily cap.
- **Consent:** only `consent === true` allows. Missing or false is off.
- **Invalid or missing zone:** the notification is held, and `availableAt` is null.
- **Held notifications:** they use no cap, and the same id can pass later.
- **Quiet hours:** 22:00 includes the start minute, and 08:00 is the first allowed minute.
- **Cap:** 3 per local calendar day.
- **Rule codes:** `NO_CONSENT`, `INVALID_TIMEZONE`, `QUIET_HOURS` and `DAILY_CAP`.
- **`availableAt`:** it is the next 08:00 local time, pushed to a later day if that day's cap is already full. It is null for no consent and for an invalid zone.

One choice for you to confirm: `dryRun` counts a repeated user and notification id once, not twice. If you want repeats counted as events, say so and I will change it.
