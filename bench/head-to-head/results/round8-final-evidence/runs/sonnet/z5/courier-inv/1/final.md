`bot.mjs` is written in the current folder, and I ran it against a set of test calls. Every case gave the result I expected, including the repeat check after a restart. I didn't add a `package.json` or install anything, because it only uses Node built-ins. Nothing is actually sent.

The gate says no, with a short plain-sentence `reason`, in these cases:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** the user has it on. I chose to suppress in-app messages too, not just push.
- **New account:** `accountAgeDays` is under 3.
- **Weak finding:** `dataPoints` is under 5 or `confidence` is under 0.6.
- **Repeat finding:** the same `insight.key` was already shown to that user in the last 30 days.
- **Too soon:** another message was shown to that user in the last 4 hours.
- **Daily limit:** 2 messages already shown that day, counted in the user's own timezone.
- **Bad input:** a required field is missing.

When it says yes, `surfaces` is `["inApp"]` by default. `"push"` is added only when all of these hold:
- The confidence is 0.8 or higher and `dataPoints` is 10 or higher.
- The local hour is between 8:00 and 22:00.
- The user hasn't mostly dismissed past messages in that hour. That means at least 5 earlier messages in the hour and more than 60% dismissed.

State is saved in `STATE_DIR/gate-state.json`, and a message is recorded only when it is shown. Calls are handled one at a time, so two simultaneous calls can't both get past the daily limit.

All the thresholds above are my own guesses. They are constants at the top of `bot.mjs` if you want different values.

I loaded the Courier skill as asked, but none of it applied here because nothing is delivered.
