`bot.mjs` is written in the current folder. It has no dependencies, so `package.json` is unchanged. I tested it with a throwaway script and a temporary `STATE_DIR`, and all checks passed. Nothing is actually sent.

`decide` stays quiet in these cases, and the first matching one sets `reason`:
- **Crisis or focus:** `context.crisis` is true, or the user has `focusMode` on.
- **Night:** the user's local time is between 22:00 and 08:00. An invalid timezone falls back to UTC.
- **New account:** the account is under 2 days old.
- **Weak insight:** confidence is below 0.7, or it rests on fewer than 5 data points.
- **Dismissed hour:** at least 4 earlier observations exist for this hour and the user acted on under 25% of them.
- **Repeat:** the same `candidate.id` was already shown, or the same `insight.key` was shown in the last 14 days.
- **Frequency:** a message was shown in the last 6 hours, or 2 in the last day, or 5 in the last week.

When it does send, `surfaces` is `["inApp"]` by default. It adds `"push"` only when confidence is 0.85 or higher and the user acted on at least half of earlier messages at this hour.

State is a small JSON file per user in `STATE_DIR`, written after each send. It survives a restart, and my restart check confirmed a repeat key was still blocked in a new process. With 10 parallel calls for one user, exactly one was shown.

The thresholds are my own choices, kept in one `CFG` block at the top of the file, so you can tune them.
