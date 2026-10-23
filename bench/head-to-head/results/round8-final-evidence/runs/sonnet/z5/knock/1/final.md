`bot.mjs` is written in the current folder. It has no dependencies, so `package.json` is unchanged. I ran it with test inputs and it behaved as intended. Nothing is actually sent.

**Checks, in order.** The first one that fails returns `send: false` with a plain-sentence `reason`:
1. Crisis: nothing is shown.
2. Focus mode or do-not-disturb: nothing is shown.
3. Night in the user's own timezone (22:00 to 08:00): nothing is shown. An invalid timezone also means nothing is shown, because the local hour can't be known.
4. Account younger than 2 days: nothing is shown.
5. Fewer than 5 data points, or confidence below 0.6: nothing is shown.
6. The same `candidate.id` was already delivered: nothing is shown. Calling `decide` twice for one candidate can't deliver it twice.
7. The same `insight.key` was delivered in the last 7 days: nothing is shown.
8. A message was delivered less than 4 hours ago, or 2 were delivered in the last 24 hours: nothing is shown.
9. In this local hour the user dismissed at least 70% of at least 5 earlier messages: nothing is shown.

**Surfaces.** Push plus in-app is used only when confidence is at least 0.8 and this hour's history isn't mostly dismissals. Otherwise the message is in-app only.

**State.** Each user gets one JSON file in `STATE_DIR`, which is created if needed. Writes are atomic, and a lock plus an in-process queue make concurrent calls safe. Records older than 30 days are pruned.

**Verification.**
- **Gate cases:** I tested the duplicate id, same key, minimum gap, crisis, focus, night, low confidence, dismissed hour, in-app-only and bad timezone cases, and each gave the expected result.
- **Concurrency:** Three concurrent calls for one user delivered exactly 1 message.
- **Restart:** After a separate process restart, the already-delivered candidate was refused.
- **Not exercised:** The 2-per-24h cap never ran, because that test call fell in the user's night hours and was refused by the night check first.

The numeric thresholds (hours, gaps, limits) are my own choices and sit in the `CFG` object at the top of the file.
