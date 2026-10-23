`bot.mjs` is written in the current folder. My check script passed, and it never sent anything. It needs no dependencies, so `package.json` is unchanged. The check script is in `/tmp/bot-check/check.mjs`, outside the project.

`decide` stays quiet, with a plain-sentence `reason`, in these cases, checked in this order:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** the user has do-not-disturb or focus on.
- **Night:** the user's local time is 22:00–08:00. If the timezone is invalid, it falls back to UTC.
- **Weak finding:** it rests on fewer than 5 data points or has confidence below 0.6.
- **Unwelcome hour:** in the current local hour the user has at least 5 earlier reactions and 70% or more were dismissals.
- **Repeat:** the same candidate `id` was already shown, or the same `insight.key` was shown within 7 days.
- **Too much:** 2 messages were already shown on the user's local day, or the last one was less than 4 hours ago.

When it does send, `surfaces` is `["push", "inApp"]` if confidence is 0.8 or higher and the user has acted at least as often as dismissed in that hour. Otherwise it is `["inApp"]`.

The thresholds are my choices, since you didn't specify any. They are constants at the top of the file.

Each send is saved as one JSON file per user in `STATE_DIR`, so it survives a restart. History older than 30 days is dropped. Calls for the same user within one process are serialized, so three simultaneous identical calls produced exactly one send. Separate processes writing for the same user at the same time are not protected.

The check script covered:
- a first send
- the repeat, gap, same-key and daily-cap blocks
- state surviving a re-import of the module
- each quiet rule on its own
- the inApp-only case
- the concurrent-call case

If `STATE_DIR` is not set, `decide` throws an error rather than sending without a memory of what was shown.
