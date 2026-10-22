I wrote `bot.mjs` in the work directory (`knock-g2-3/bot.mjs`). It has no dependencies and exports `createPushGate()`. All 13 tests pass. They live in `/tmp/pg-test/bot.test.mjs`, outside the repo. Nothing was sent or committed.

**Behavior**, checked in this order:
- **`quiet_hours`**: `now` falls in the user's quiet window, read on their own clock in `timeZone`. Windows that cross midnight work. Start is inclusive and end is exclusive, so 22:00 is quiet and 07:00 is not.
- **`daily_cap_reached`**: the user already has `dailyCap` allowed pushes on their local calendar day. "Per day" means that person's day in their zone, not UTC and not a rolling 24 hours.
- **`min_gap`**: the last allowed push to this user was less than 60 minutes ago.

Blocked attempts don't count as sent. Allowed attempts are recorded, and history older than 3 days is pruned.

**Choices I made that you didn't specify:**
- **60-minute minimum gap.** This is my number. Apple and Google don't publish a specific count, and I did not check their current docs. Change `MIN_GAP_MS` if you want something else.
- **Equal `quietStart` and `quietEnd`, or `null`, means no quiet window.** I did not treat an equal pair as all day.
- **Bad input throws** (`TypeError`, or `RangeError` for an unknown zone) rather than returning a reason code. Those are caller bugs, so the agent sees them immediately.
- **Out-of-order `now` values** are handled without crashing. The gap check uses the absolute difference, so a clock that moves backwards still respects the gap.

**Limits:**
- The gate can't see the device's Focus or Do Not Disturb state. Quiet hours come only from the settings you pass in.
- I ran the tests on Node 24, the only version here. The code uses nothing newer than Node 22 supports, but I did not run it on Node 22.
