`bot.mjs` is written in the current folder, and my check script passes. I haven't run it against real app data, and nothing is sent anywhere. It needs no dependencies, so `package.json` is unchanged.

`decide` stays quiet in these cases, in this order:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** `user.focusMode` is true.
- **Night:** the user's local time is 22:00 to 08:00. An invalid timezone also counts as quiet.
- **Weak finding:** `confidence` is below 0.6, or `dataPoints` is below 5.
- **Bad hour:** the user acted on fewer than 25% of messages at this hour, with at least 3 past reactions.
- **Repeat:** the same `insight.key` or candidate `id` was shown in the last 14 days.
- **Too soon:** another message was shown less than 4 hours ago.
- **Daily limit:** 2 messages already shown today in the user's local day.

If none of those apply, it returns `send: true` with `reason: null`.
- **Surfaces:** `inApp` by default. `push` is added only when `confidence` is at least 0.85 and the user acted on at least half of past messages at this hour, with at least 3 past reactions.
- **Delivery record:** a shown message is saved immediately and counts as delivered. The record lives in one file per user under `STATE_DIR`, so it survives a restart.
- **Concurrent calls:** a lock keeps them from both passing the limits. Three simultaneous calls for one user gave exactly one send.
- **Bad input:** a missing `STATE_DIR` or incomplete input returns a quiet result instead of throwing.

The check script is at `/tmp/botcheck.mjs`, outside the project folder. It covered each rule above, the push/inApp choice, the next-day reset, concurrency and a restart. One gap: in my run the "daily limit" step was actually blocked by the 4-hour gap rule first, so the 2-per-day limit itself wasn't isolated.
