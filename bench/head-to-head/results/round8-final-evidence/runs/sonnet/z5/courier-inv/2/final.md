`bot.mjs` is written in the current folder. It needs no dependencies, so there is no `package.json`. I ran it against a scratch state directory and nothing was actually sent.

`decide` stays quiet in these cases, with a plain-sentence `reason` for each:
- **Crisis or focus mode:** `context.crisis` is true or `user.focusMode` is on.
- **Weak finding:** `confidence` is below 0.6, or `dataPoints` is below 5.
- **New account:** `accountAgeDays` is below 3.
- **Night:** the user's local time is 21:00–08:00. An unknown timezone also stays quiet.
- **Bad hour:** earlier messages at this local hour were dismissed more than 70% of the time, with at least 5 samples.
- **Repeats:** the same `insight.key` was shown in the last 14 days, or the same candidate `id` was already shown.
- **Frequency:** another message was shown less than 4 hours ago, or two were already shown that local day.

When it sends, it counts as delivered and the send is recorded. It picks the surfaces like this:
- **`["inApp"]`:** the default.
- **`["push", "inApp"]`:** only when confidence is at least 0.8 and the user has acted on messages at least as often as they dismissed them at that hour, with at least 3 samples.

State is one JSON file per user in `STATE_DIR`, created if missing and written by rename. The file is read again on every call, so a restart keeps it. I confirmed this by loading it in a fresh process. Concurrent calls for the same user are only serialized inside one process, not across processes.

I tested these cases and each gave the expected result:
- A normal send.
- A repeated key.
- The 4-hour gap.
- A second send later the same day.
- A send the next day.
- Crisis.
- Focus mode.
- Night.
- Low confidence.
- A dismissed hour.
- A bad timezone.

I did not exercise the daily cap on its own: in my test run the 4-hour gap fired first.

The thresholds are constants at the top of the file, so you can tune them. I picked the values myself, since you didn't specify any.
