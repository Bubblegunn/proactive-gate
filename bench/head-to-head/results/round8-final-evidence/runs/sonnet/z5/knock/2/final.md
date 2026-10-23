`bot.mjs` is written in the current folder and exports `decide`. It needs no dependencies. I ran it against a temporary `STATE_DIR` with a short script. Most cases behaved as intended, but I did not test the daily cap or concurrent calls.

`decide` stays quiet in these cases, each with a plain-sentence `reason`:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** `user.focusMode` is true.
- **Weak finding:** `dataPoints` is under 3 or `confidence` is under 0.6.
- **Repeated finding:** the same `insight.key` was already delivered to that user in the last 14 days. A repeated `candidate.id` is also blocked.
- **Daily limit:** 3 messages were already delivered to that user in the last 24 hours.
- **Dismissed hour:** the user's local hour has at least 5 recorded reactions and more than 70% were dismissals.

I chose the thresholds and the quiet-hours rule (22:00 to 08:00) myself. Change the constants at the top of the file if you want different values.

During local quiet hours it returns `["inApp"]` only, with no push. Otherwise it returns `["push", "inApp"]`. An invalid timezone falls back to UTC.

A delivery is recorded in `STATE_DIR/state.json`, so it survives a restart. The directory is created if it is missing. Writes go through a temp file and a rename, and a lock directory serializes concurrent callers. Delivery records older than 30 days are dropped.

What the test run showed:
- **Delivery:** a normal case went out on push and in-app.
- **Silent cases:** the duplicate, crisis, focus, low-confidence and dismissed-hour cases were all silent.
- **Night case:** a 23:00 case went out in-app only.
- **Restart:** a new process still blocked the repeated finding.
- **Not checked:** the daily-cap block was not triggered, and I did not run concurrent calls.
