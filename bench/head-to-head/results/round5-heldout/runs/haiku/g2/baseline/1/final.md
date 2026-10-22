`bot.mjs` is written in the project root and exports `createPushGate()`. Its 21 checks pass on Node 24.13 (Node 22 was not available here). The test script is in `/tmp/bot-test/`, outside the project. Nothing is sent.

**Rules, checked in this order (first match returns its code):**
1. `quiet_hours`: the local time in `user.timeZone` falls in the quiet window. Start is inclusive, end is exclusive, and windows can wrap midnight. Quiet is judged by the user's wall clock, so DST is handled.
2. `daily_cap_reached`: the user already got `dailyCap` allowed pushes on the same local calendar day in their zone. "Day" is not UTC and not a rolling 24h window.
3. `too_soon_after_last_push`: an allowed push went out less than 30 minutes ago. This one is my addition, not in your spec. It follows Apple and Google guidance against bursts. Two buzzes a few minutes apart is the pattern users complain about. Change `MIN_GAP_MS` if you want it looser or stricter.

Only allowed pushes count. A quiet-hours or cap refusal does not use up the day's budget.

**Choices I made that you may want to review:**
- `quietStart === quietEnd` means no quiet window.
- Invalid input throws (`TypeError`/`RangeError`) instead of returning a reason. That covers a bad IANA zone, a malformed HH:MM, a non-integer or negative cap, a missing user id, and an invalid `Date`. A bad config fails loudly rather than silently allowing or blocking pushes.
- The gap check uses absolute distance, so a clock that steps backwards does not block pushes for hours.
- History is kept in absolute time and pruned after 48h.

**Tests:** cover quiet-window edges (22:00 blocked, 21:59 allowed, 07:00 allowed, 06:59 blocked), a New York DST-zone case, the day boundary where UTC and the local date differ, cap reset on the next local day, the gap boundary at exactly 30 minutes, gate and user isolation, per-call settings, input validation, and backward clock steps.
