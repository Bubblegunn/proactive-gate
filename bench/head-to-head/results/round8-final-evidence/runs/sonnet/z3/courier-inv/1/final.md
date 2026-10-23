`bot.mjs` is written in the current folder, and my checks pass. It uses only Node built-ins, so `package.json` is unchanged. I read the courier skill but it had nothing specific for this, so the rules below are my own choices.

**How `deliver` decides**
- **Morning window:** the push goes out only between 07:00 and 11:00 in the user's own time zone (DST-aware). Outside that window the push is withheld and `resumeAt` is the next 07:00 local. If the time zone is invalid, the push is withheld with no `resumeAt`.
- **Snooze and switched-off categories:** if `snoozedUntil` is in the future, nothing is sent. `resumeAt` is the later of the snooze end and the next window opening. If `categories[type] === false`, nothing is sent at all.
- **Push is stricter than in-app:** a push needs `categories[type]` to be exactly `true`. A missing category still gets the in-app item but no push.
- **Phone settings:** `notificationsPermitted === false` blocks the push. A missing value still tries the push.
- **Consent:** the push is blocked if the store throws or returns a non-object. It is also blocked if `consents.push` or `consents[type]` is `false`. You didn't name the consent purposes, so I guessed those two keys; change them if your store uses others.
- **Dismissals:** `recordDismissal` stores each swipe. Three dismissals of one type within 7 days pause pushes of that type, and `resumeAt` is when the count drops below three. The in-app item is still stored.
- **Push rejected:** if `transport.push` returns false or throws, the in-app item is kept and `reason` says so.
- **Once only:** a candidate's push and in-app item are each sent at most once, even if `deliver` is called again. A retry can still send whichever one didn't go out earlier, for example the push once the window opens. Only one briefing push goes out per local day.

**Shared state:** each user gets one JSON file in `STATE_DIR`. A lock directory per user keeps the worker processes from overwriting each other, and stale locks are cleared after 60 seconds. Writes go to a temp file and are then renamed into place, so state survives a restart.

**Checks I ran** (script in `/tmp/t`, not in your folder):
- A normal send.
- A repeat call for the same candidate.
- Night time, with the right `resumeAt`.
- Snooze.
- Category off and category missing.
- Consent store down.
- Push rejected by the phone.
- The dismissal pause.
- Eight separate processes delivering the same candidate at once, which produced exactly one push and one in-app item.

I didn't test a DST-change day or an Android user.
