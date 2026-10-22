I wrote `bot.mjs` in the working directory. It exports `createPushGate()`, has no dependencies, and sends nothing. All 12 behavioral checks pass on Node v24.13.0 locally. The code uses only APIs that Node 22 has, but I did not run it on Node 22. The check script is in `/tmp/bot-check/`, outside the project. I did not commit.

**How `attempt(user, now)` decides.** Checks run in this order, and the first one that fails sets `reason`:

1. **`quiet_hours`**: the user's local wall-clock time, in their `timeZone`, falls in `[quietStart, quietEnd)`. A range where start is later than end wraps past midnight, so 22:00–07:00 covers the night. The end time is exclusive.
2. **`daily_cap_reached`**: the user already has `dailyCap` allowed pushes on the same local calendar day. "Day" means the user's midnight, not a rolling 24 hours or UTC. The count uses the `timeZone` passed on the current call, so it still works if a user travels.
3. **`too_soon`**: another allowed push went to this user less than 60 minutes before or after `now`. This stops bursts, such as a "recipe ready" push right after a "lunch" push.

If `allowed` is true, the push is recorded. A denied call is not recorded, so it does not use up the cap. Each gate keeps its own in-memory history per `user.id`, and history older than 48 hours is dropped.

**Choices you may want to change:**
- **60-minute gap.** The Apple and Google guidance asks for restraint but gives no number. `MIN_GAP_MS` is a constant at the top of the file.
- **`quietStart === quietEnd` means no quiet period.** The alternative is a 24-hour quiet period. I chose the first because a zero-length window should not silence the user all day.
- **Bad input throws `TypeError`.** This covers a malformed HH:MM, a negative or non-integer `dailyCap`, an invalid `now`, or a missing `user.id`. It does not return a `reason`. If the agent should keep running after a bad setting, the caller needs a `try/catch`, or the gate could fail closed with its own reason code.
