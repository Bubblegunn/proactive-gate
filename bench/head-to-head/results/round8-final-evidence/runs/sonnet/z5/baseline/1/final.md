`bot.mjs` is written, and I ran it against a temporary state directory. All the cases I tried gave the expected result, including state surviving a restart. It has no dependencies, so `package.json` is unchanged.

`decide` stays quiet (`send: false`, `surfaces: []`, plain-sentence `reason`) in these cases:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** `user.focusMode` is true. This blocks push and in-app alike. In-app only appears when the user opens the app, so I could allow it here, but I chose full silence.
- **Weak finding:** fewer than 5 `dataPoints`, or `confidence` below 0.6.
- **Repeat finding:** the same `insight.key` was already shown to that user in the last 14 days.
- **Frequency:** 2 messages already shown in the last 24 hours, or the last one was under 4 hours ago.
- **Dismissed hour:** this local hour has at least 5 recorded reactions and more than 60% were dismissals.

When it does send:
- **Push and in-app:** both are used only when `confidence` is at least 0.8 and the user's local time is 08:00–21:59.
- **In-app only:** otherwise, including 22:00–07:59 or an unreadable timezone.
- **State:** a send is recorded per user in `$STATE_DIR/proactive-state.json`. The file is written atomically, and calls are processed one at a time within a process.

The thresholds are my own choices, set as constants at the top of the file. Nothing is actually sent.

My tests were a short script in `/tmp`, so no test file was added to the folder.
