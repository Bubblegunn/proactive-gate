I wrote `bot.mjs` in the repo working directory. It exports `createPushGate()`, returning `{ attempt(user, now) }`. All 16 behavior checks pass on Node 24; I have not run it on Node 22 itself. Nothing is sent.

How it decides:

- **Quiet hours** are checked first, in the user's own IANA zone. The window runs from `quietStart` up to but not including `quietEnd`, and wraps past midnight when start is later than end. Denial code: `quiet_hours`.
- **Daily cap** counts pushes that fell on today's calendar date in the user's zone, not the last 24 hours. A user at 23:50 and again at 00:10 gets two pushes, and the cap resets at local midnight. Denial code: `daily_cap`.
- **Only allowed pushes count.** Denied calls don't use up the cap.
- **History** is kept in memory per user ID and trimmed to the last two days.

Choices I made that you may want to change:

- `quietStart` equal to `quietEnd` means no quiet window.
- Invalid input throws (bad `timeZone`, bad HH:MM, negative or non-integer `dailyCap`, invalid `now`). I didn't turn these into denials, so a bad device timezone will surface as an exception in the caller. Say if you'd rather it fail closed with a reason code.
- I did not add a minimum gap between pushes. Your spec defines only the daily cap, so a spacing rule would block pushes you didn't ask it to block. It is an easy addition if the wake-up complaints persist.
- I applied general notification-etiquette principles (respect quiet hours, limit frequency, make the user's own settings win). I did not look up Apple's or Google's current guidance text, so check it if you need it cited.

The tests live outside the repo at `/tmp/pushgate-test/test.mjs`. They cover quiet-hour boundaries and midnight wrap, the per-day cap and its reset, DST, per-call setting changes, and isolation between users and gates.
