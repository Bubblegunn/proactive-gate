`bot.mjs` is written in the current folder, and `node test.mjs` passes. It needs no dependencies. I ran the tests on Node 24 here, not Node 22.

**What it does**
- **Wake-up window:** the briefing goes out only between 07:00 and 11:00 in the user's time zone, and DST is handled. Outside that window it is withheld. `resumeAt` is the next 07:00 local. Other card types are blocked from 22:00 to 07:00.
- **Snooze:** an active `snoozedUntil` withholds both the push and the in-app item. `resumeAt` is the snooze end, moved forward into the next allowed window if needed.
- **Kind switched off:** `categories[type] === false` withholds everything. A category that is missing counts as not switched off.
- **Phone permission:** if `notificationsPermitted === false`, only the in-app item is stored and `transport.push` is not called.
- **Consent:** a push is sent only if `consents.push === true`. If the store throws or the user hasn't agreed, only the in-app item is stored.
- **Dismissals:** `recordDismissal` keeps a per-user, per-type list. After 3 swipes of one type within 14 days, push for that type stops while the in-app item still goes out. `resumeAt` is when the count drops below 3.
- **Repeats:** a second `deliver` for the same `candidate.id` sends nothing and only retries a part that failed before. A second briefing on the same local day is withheld.
- **Several workers:** each user has one JSON file and one lock in `STATE_DIR`. The file is written atomically and survives a restart. A lock left by a dead worker is taken over after 60 seconds.

**Choices I made where the brief was silent**
- The consent purpose key is `push`. The brief doesn't name the purposes, so change it if your store uses another key.
- The 07:00–11:00 window, the 22:00 quiet hours and the 3-in-14-days dismissal limit are my picks. They are constants at the top of `bot.mjs`.
- An unknown or invalid time zone, or an unreadable `snoozedUntil`, withholds everything with a reason and `resumeAt: null`.

**What the tests cover (`test.mjs`)**
- Normal delivery and retry with no resend
- The one-briefing-per-day rule
- Before the window and after it
- Active and expired snooze
- Category off
- OS permission off
- Push rejected by the phone
- Consent store down and consent refused
- Invalid time zone
- Dismissals, with another type unaffected
- The Berlin DST day
- 8 processes delivering the same briefing at once, which produced exactly one push and one in-app item

I did not commit anything.
