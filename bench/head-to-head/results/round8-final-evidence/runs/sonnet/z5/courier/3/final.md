`bot.mjs` is written in the current folder, and I tested it. It needs no dependencies, so `package.json` is unchanged.

I ran 13 scenarios against it. Each one gave the expected answer, including after a restart: the state survived and earlier deliveries were still remembered. The test script is `/tmp/t.mjs`, outside the project.

A file change to `bot.mjs` was reported after my last edit. I haven't looked at what changed. The tests ran before that report, so they may not describe the file as it is now.

`decide` returns `send: false` with a short `reason` in these cases, checked in this order:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** `user.focusMode` is true.
- **Weak finding:** fewer than 5 data points, or confidence below 0.7.
- **New account:** under 1 day old.
- **Night:** 22:00 to 08:00 in the user's own timezone. An unknown timezone also means nothing is shown.
- **Dismissed hour:** this hour has 5 or more past reactions and 80% or more were dismissals.
- **Repeat:** the same candidate id was already shown, or the same finding key was shown to that user in the last 30 days.
- **Too soon:** another message went out less than 2 hours ago, or 3 have already gone out that local day.

When it does send, it returns `["push", "inApp"]`. It returns `["inApp"]` alone when this hour has enough history and under 40% of those reactions were acted on. Each sent message is saved before `decide` returns, and the history is kept per user.

I chose these thresholds and hours myself, since you didn't give any, so adjust the constants at the top of the file if they're wrong. Two choices to confirm:
- **Night:** everything is suppressed, including in-app. Because nothing is queued, a finding that arrives at night is dropped, not delayed.
- **Cross-process safety:** concurrent calls in one process are handled one at a time. Two separate processes writing to the same `STATE_DIR` at once are not protected against.

The state is stored in `STATE_DIR/proactive-state.json`. If that file is corrupt, it is renamed aside and the history starts empty.
