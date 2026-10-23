`bot.mjs` is written and tested. There are no dependencies, so `package.json` is unchanged. My test script covered the cases below, plus 5 processes writing dismissals to one user at once. All 100 writes survived and no lock was left behind.

**What `deliver` does, in order:**
1. **Category off:** if `categories[type]` is `false`, nothing goes out on either surface and `resumeAt` is null.
2. **Category never asked:** if the category is missing, no push goes out and only the in-app item is stored. A push needs an explicit `true`.
3. **Consent:** if `consentStore.get` throws, nothing is sent (fail closed). The same applies if `consents` has a `false` for the card's type, `push` or `notifications`.
4. **Snooze:** while `snoozedUntil` is in the future, nothing is sent. For briefings, `resumeAt` is the next 07:00–10:00 local slot after the snooze ends. An unreadable `snoozedUntil` also blocks the send.
5. **Briefing hours:** a briefing goes out only from 07:00 to 10:00 in the user's own timezone. Before that, `resumeAt` is 07:00 local. After that, it is 07:00 the next day. DST is handled. An invalid or missing timezone blocks the send. Other card types have no time window.
6. **One briefing per local day:** a second briefing candidate on the same local day is withheld.
7. **Dismissal fatigue:** after 3 dismissals of a type within 7 days, pushes of that type stop but the in-app item is still stored. `resumeAt` is when the count drops below 3.
8. **Phone permission:** if `notificationsPermitted` is `false`, no push is sent but the in-app item is stored. If it is missing, the push is tried.
9. **Push not accepted:** if `transport.push` returns false or throws, the in-app item is still stored and `reason` says so.

**Duplicate and retry safety:** state is saved per user and per candidate id. A retry of the same candidate only sends the surface that is still missing, so a push is not sent twice.

**Shared state:** `STATE_DIR` holds one JSON file per user, written atomically (temp file, then rename). A lock directory per user covers the whole read-modify-write, including the transport calls. A lock older than 60 seconds is treated as stale and removed. If a transport call takes longer than that, another worker could break the lock and a duplicate send becomes possible.

**Decisions I made that you may want to change:**
- **Briefing hours:** 07:00 to 10:00 local, set by `WAKE_HOUR` and `END_HOUR`.
- **Fatigue limit:** 3 dismissals in 7 days, set by `DISMISS_LIMIT` and `DISMISS_PERIOD_MS`.
- **Consent keys:** I didn't know your purpose names, so I check `<type>`, `push` and `notifications`. A missing key does not block a send.
- **Category off or snooze:** both block the in-app item as well as the push.

I did not use the Courier SDK or send anything, since you asked for the two `transport` calls only.
