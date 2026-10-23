`bot.mjs` is written and passes my checks. I ran it only against a temporary state directory and sent nothing. It needs no dependencies, so `package.json` is unchanged.

`decide` returns `send: false` with a plain reason in these cases, checked in this order:
- **Crisis or focus mode:** `context.crisis` is true, or the user has focus mode on.
- **Night:** the user's local time is 22:00–08:00, or the timezone is invalid, so the local hour is unknown.
- **Weak finding:** confidence is below 0.6, or it rests on fewer than 5 data points.
- **Bad hour:** at least 5 earlier messages in this local hour, and more than 60% were dismissed.
- **Repeat:** the same candidate id was already shown, or the same `insight.key` was shown in the last 14 days.
- **Too frequent:** a message went out in the last 6 hours, one already went out today (local day), or 3 went out in the last 7 days.

When it does send, `surfaces` is `["inApp"]` by default. It adds `"push"` only when confidence is at least 0.85 and the user acted on at least 3 messages in this hour and acted on at least half of them. The 22:00–08:00 window, the frequency limits and the push thresholds are my own choices, since the spec didn't give numbers. I took them from the Knock skill's guidance on quiet hours, frequency caps and push for urgent items. They're constants at the top of the file if you want to change them.

State is saved per user in `STATE_DIR`, and a send is recorded only when one is returned. The directory is created if missing and writes are atomic. A lock directory keeps concurrent calls from both sending.

Checks I ran:
- **Each rule:** every rule above returned the expected result.
- **Push vs inApp-only:** one case produced `["push","inApp"]` and another produced `["inApp"]`.
- **Sends on a later day:** a send went through again after a day passed.
- **Concurrency:** three simultaneous calls for one user produced exactly one send.
- **Restart:** a fresh Node process still knew about the earlier send and returned "already shown".
