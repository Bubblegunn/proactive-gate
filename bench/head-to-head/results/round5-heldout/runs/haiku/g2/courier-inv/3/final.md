`bot.mjs` is written at `work/courier-inv-g2-3/bot.mjs`. All 16 tests pass. They run from `/tmp/bot-gate-test`, outside the project. Nothing was sent.

**How it decides** (checked in this order, first failure sets the code):
- `invalid_timezone`, `invalid_quiet_hours`, `invalid_daily_cap`: the settings can't be used. These deny rather than guess.
- `quiet_hours`: the user's local clock is inside the quiet window. A window like 22:00–07:00 wraps midnight. The end time is exclusive, so 07:00 is allowed. Equal start and end means no quiet period.
- `daily_cap_reached`: the user already got `dailyCap` allowed pushes on their local calendar day (midnight to midnight in `timeZone`).
- `allowed: true` with `reason: null` also counts as a push sent. Denied attempts don't count.

**Choices I made that you may want to change:**
- "Day" is the user's local calendar day, not a rolling 24 hours. A push at 23:50 doesn't block one at 00:10.
- "Night" is the user's local clock, not UTC or the server's clock.
- If both `quietStart` and `quietEnd` are absent, there is no quiet period. I did not add a default night window.
- Bad user settings return a deny code. Programmer errors (missing `user.id`, a non-Date `now`) throw a `TypeError`, so they show up loudly.
- History is kept for 48 hours in memory, which covers any local day. It is lost on restart, as you specified.

**Apple and Google guidance:** I did not fetch their live docs. The quiet-hours and cap rules come from the general principle that nudges should respect the user's local time and stay sparse. Check the current HIG and Android notification guidelines before you cite them externally.

**Courier skill:** The skill's throttle guidance covers Courier-side caps, which only exist inside journeys. This gate runs in-process before the agent decides to send, so I wrote it as plain code.
