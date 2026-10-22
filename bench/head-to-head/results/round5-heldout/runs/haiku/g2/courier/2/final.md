Wrote `bot.mjs` in the working directory. It exports `createPushGate()`, and the checks pass. Nothing was sent and nothing was committed.

**How it decides**, checked in this order:
1. **`quiet_hours`**: the local time in `user.timeZone` falls in the quiet period. Start is inclusive and end is exclusive. A period like 22:00–07:00 wraps past midnight.
2. **`daily_cap_reached`**: the user already got `dailyCap` pushes on the same local calendar date in their zone. The count resets at their local midnight, not UTC midnight.
3. **`min_gap`**: the last allowed push was less than 30 minutes ago.

Only allowed attempts count as sent. Each gate keeps its own history in memory, and history older than 48 hours is dropped. Settings are read on every call.

**Choices I made that you may want to change:**
- **30-minute minimum gap.** This is my addition, not in your spec. It stops a burst of pushes at one moment, which is the kind of thing that wakes people. The constant is `MIN_GAP_MS` at the top of the file.
- **Default quiet hours of 22:00–07:00** when `quietStart` or `quietEnd` is missing. If you'd rather have no quiet period in that case, change the defaults.
- **`quietStart` equal to `quietEnd` means no quiet period.**
- **Bad input throws** (`TypeError` or `RangeError`) instead of returning a denial. This covers an unknown zone, a malformed HH:MM, a negative or non-integer `dailyCap`, and an invalid `Date`.

**Apple and Google guidance:** I had no web access here, so I did not check their current docs. The design follows the general principles: respect quiet hours and Focus, limit frequency, and avoid bursts. Please verify against the current guidelines before relying on that.

**Testing:** I ran `/tmp/pushgate-check/check.mjs` against the file, outside the project. It covers the cap, the 30-minute gap, quiet-hour boundaries including midnight wrap, a non-wrapping quiet period, local-day reset across time zones, independent gates, per-call settings, defaults, blocked attempts not counting, and input validation. One assertion failed at first because my test case was wrong: 23:50 Tokyo is inside quiet hours. I fixed the test, not the gate.
