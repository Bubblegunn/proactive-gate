`bot.mjs` is written in the current folder. It needs no dependencies, so `package.json` is unchanged. I ran it with a throwaway script (no real sends) and every case below behaved as intended. State survived a fresh Node process: a repeat of an already-shown candidate was refused. I only ran it on Node 24 here, not Node 22.

`decide` stays quiet when any of these is true:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** `focusMode` is true. I chose to block both surfaces here, because an in-app message still interrupts someone in focus.
- **New account:** `accountAgeDays` is under 1.
- **Weak finding:** `dataPoints` is under 5 or `confidence` is under 0.6.
- **Bad hour:** the user's local hour has at least 5 recorded reactions and more than 70% were dismissed.
- **Already shown:** the same candidate `id` was delivered before, or the same `insight.key` within the last 14 days.
- **Too frequent:** the last message was under 4 hours ago, 2 messages are already delivered today (in the user's timezone), or 5 in the last 7 days.
- **Bad input:** a field is missing or `now` is invalid.

When it does send, `surfaces` is `["inApp"]` by default. It adds `"push"` only when confidence is 0.8 or higher and the user's local time is between 08:00 and 22:00.

**State:** it keeps one JSON file per user in `STATE_DIR`, creating the folder if needed. It records a send only when it returns `send: true`. Writes are atomic and calls are serialized within one process. There is no lock across separate processes, so two processes deciding for the same user at the same moment could both send.

All the thresholds (5 data points, 0.6 confidence, 2 per day, and so on) are my own choices, set as constants at the top of the file.
