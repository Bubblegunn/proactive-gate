`bot.mjs` is written, and my checks pass. It needs no dependencies, so I left `package.json` alone.

I'm finishing up. The test run showed all 8 parallel workers produced exactly one push and one in-app item for the same briefing. All 40 dismissals (8 workers × 5) were recorded with none lost.

**How `deliver` decides**
- **Switched off:** `categories[type] === false` delivers nothing.
- **Snoozed:** delivers nothing, and `resumeAt` is the snooze end. If that falls outside the wake window, it moves to the next 07:00 local.
- **Briefing window:** the briefing goes out only between 07:00 and 11:00 in the user's timezone. Outside that, nothing is delivered and `resumeAt` is the next 07:00 local, including across DST changes.
- **Other card types:** these get no push between 22:00 and 07:00 local, but the in-app item is still stored.
- **Push needs all of these:**
  - The category is explicitly `true`.
  - `notificationsPermitted` is not `false`.
  - `consents.push === true`.
  - The user has not dismissed that type 3 or more times in the last 14 days. After the third dismissal, push pauses for 7 days.
  - No other push of that type went out the same local day.
  - The candidate was not pushed before.
- **Push failures:** if consent is missing, the consent store throws, or `transport.push` returns false or throws, push is withheld. The in-app item is still stored and `reason` explains why.
- **Unusable input:** an unknown timezone or an unreadable `snoozedUntil` withholds everything.
- **Duplicates:** the same `candidate.id` never gets a second push or a second in-app item.

`recordDismissal` appends a timestamp under the same per-user lock. State is one JSON file per user in `STATE_DIR`, written atomically, so it survives a restart.

**Assumptions to confirm**
- The consent purpose key is `push`, and a missing consent counts as no consent. If your store uses a different key, change it in `bot.mjs`.
- A user whose category setting is missing (never asked) gets no push. They still get the in-app item.
- The thresholds are mine, not from your spec: the 07:00–11:00 window, the 22:00 quiet start, 3 dismissals in 14 days, and a 7-day pause. They are constants at the top of the file.

My test script (`/tmp/ct/test.mjs`) is outside the project folder and passes.
