`bot.mjs` is written in the current folder. It needs no dependencies. My test script passed, and 12 worker processes racing on one user and day sent exactly one push.

**What `deliver` does, in order**
1. **Category off:** if `categories[type] === false`, it sends nothing and returns `resumeAt: null`.
2. **Timezone:** a missing or invalid timezone withholds the briefing, because the wake-up time can't be known.
3. **Snooze:** if `snoozedUntil` is in the future, it sends nothing and `resumeAt` is the snooze end. An unparseable `snoozedUntil` also withholds, with no `resumeAt`.
4. **Wake window:** the briefing goes out only between 07:00 and 11:00 in the user's local time. Outside that, nothing is sent and `resumeAt` is the next 07:00 local, converted to UTC. This was checked across the New York daylight-saving change.
5. **Duplicates:** at most one briefing per user per local day, and one card per user per candidate id. A repeat call returns `{push: false, inApp: false}` with a reason. If neither surface delivered, the claim is released so a retry can send.
6. **Push is withheld, but the in-app item is still stored, when any of these hold:**
   - `notificationsPermitted === false`.
   - The user never opted in to that category.
   - The consent store has no `push` or `notifications` consent set to true, or it throws.
   - The user dismissed that type 3 or more times in the last 7 days. `resumeAt` is then when that count drops below 3.
   - It is quiet hours (22:00–07:00 local) for a non-briefing card.
7. **Push rejected:** if `transport.push` returns false or throws, the in-app item is still stored and `reason` says so.

`recordDismissal` appends the dismissal to the user's state file.

**State:** one JSON file per user in `STATE_DIR`, created if missing. Workers share it through a lock directory, writes are atomic, and the state survives a restart.

**Choices to confirm**
- Push needs an explicit `categories[type] === true` plus consent. If a user was never asked, they get the in-app item only. Say if you'd rather treat "never asked" as allowed.
- The consent purpose key isn't specified, so I check `consents.push`, then `consents.notifications`. Change it if your store uses another key.
- The 07:00–11:00 window, 22:00 quiet start, and 3-in-7-days dismissal rule are constants at the top of the file.

I did not test a crash mid-send, a claim left stuck by a dead worker, or DST gaps in zones other than New York.
