`bot.mjs` is written and works. `test.mjs` ran clean in this folder. No dependencies were needed, so `package.json` is unchanged.

**What the tests cover:** each rule below, plus 16 separate worker processes handling one user at once, which produced exactly one push.

**Rules I chose where your spec was silent** (each is a constant or check near the top of `bot.mjs`, so you can change it):
- **Send window:** pushes go out only between 08:00 and 21:00 in the user's local timezone. The briefing push goes out only between 08:00 and 11:00. Outside the window, nothing is sent and `resumeAt` is the next 08:00 local. This handles daylight-saving changes.
- **Notification settings:** a category is on only if `categories[type] === true`. If the user turned it off or was never asked, nothing is sent, neither push nor in-app, and `resumeAt` is null.
- **Snooze:** a snooze in the future withholds both surfaces. `resumeAt` is the end of the snooze, moved forward to the next allowed time if that falls outside the window.
- **Dismissals:** `recordDismissal` saves each swipe. Three swipes of one card type within 14 days pause that type for 7 days after the last swipe.
- **One briefing a day:** only one briefing goes out per user per local day.
- **Repeats:** a retry of the same `candidate.id` returns the earlier result and does not send again. A worker that crashes mid-push never repeats that push.
- **Push consent:** a consent store error, or `push`, `notifications` or the card type set to false, withholds the push. The in-app item is still stored. Your spec didn't say which consent keys apply to the briefing, so I guessed `push`, `notifications` and the card type.
- **Push not sent:** if the phone permission is off, the timezone is invalid, or `transport.push` returns false or throws, the in-app item is still stored and `reason` says why.
- **Errors:** `deliver` never throws. If something fails internally, it sends nothing and says so in `reason`.

Per-user state lives in `STATE_DIR` as one file per user, behind a lock, so it survives restarts and is safe across workers. If `STATE_DIR` isn't set, it falls back to `./.state`.

Three of these were guesses: the 08:00 to 11:00 briefing window, the dismissal pause thresholds, and treating a never-asked category as no consent. Say if you want different values or behavior.
