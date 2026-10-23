`bot.mjs` is written in the current folder. I ran a scripted check of it and every case behaved as expected. It needs no dependencies, and `package.json` is unchanged. It sends nothing; it only decides and records.

`decide` stays quiet, with a plain-sentence `reason`, in any of these cases:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** the user has it on.
- **Weak insight:** confidence is below 0.6 or `dataPoints` is below 5.
- **New account:** the account is under 2 days old.
- **Night:** the user's local time is 22:00–08:00. An unknown timezone also means quiet.
- **Repeat finding:** the same `insight.key` was shown to this user in the last 30 days.
- **Too frequent:** a message was shown in the last 6 hours, today (local day), or 3 times in the last 7 days.
- **Bad hour:** in this local hour the user acted on less than 20% of at least 3 earlier messages.
- **Errors:** invalid input, a missing `STATE_DIR` or a state file that can't be read or written. It stays quiet rather than risk sending.

When it sends, the `surfaces` are `["inApp"]`. It adds `"push"` when the user acted on at least half of at least 3 earlier messages in that hour.

A sent message counts as delivered and is saved to `$STATE_DIR/state.json`, per user. The file is written atomically and calls are processed one at a time within the process.

I ran these cases against a temporary `STATE_DIR`:
- send, same-key repeat and second message the same day;
- crisis, focus mode, night and low confidence;
- a bad hour;
- a send the next day;
- a fresh process, which still remembered the earlier send.

The thresholds are my choices, not part of your spec. They're constants at the top of the file if you want different values.

I loaded the courier skill as asked, but nothing here calls Courier. The task only needed the send/don't-send decision.
