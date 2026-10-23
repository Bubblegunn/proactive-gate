`bot.mjs` is written in the current folder. It uses only Node built-ins, so `package.json` is unchanged.

I tested it with a script outside the folder, using fake transports and a fake consent store. All checks passed:
- A normal 08:00 local delivery reaches both surfaces.
- A repeat call for the same candidate does not resend anything.
- A second briefing on the same local day is dropped, and `resumeAt` is the next morning.
- 07:00 UTC for a New York user is not morning there, so push is withheld and the in-app item is stored.
- Snooze, category off, a consent store that throws, a push that returns false, missing `categories`, and three dismissals each give the result described below.
- 8 worker processes on one shared `STATE_DIR` (same user, two candidates) produced exactly one push and one in-app item. 40 concurrent dismissal writes left the state file intact.

## What the code does

- **Category off:** if `categories[type] === false`, nothing goes out on either surface.
- **Push needs a "yes":** if `categories[type]` is missing, push is withheld but the in-app item is still stored. The same applies when `notificationsPermitted` is false or `consents.push` is false.
- **Consent:** a throwing consent store means nothing is sent on either surface and `resumeAt` is null. `consents.notifications === false` or `consents[type] === false` also blocks both surfaces.
- **Snooze:** push is withheld until `snoozedUntil` and `resumeAt` is set. The in-app item is still stored.
- **Timing:**
  - A briefing push goes out only between 07:00 and 11:00 in the user's timezone. Other card types go out between 07:00 and 22:00.
  - Outside that window, push is withheld and `resumeAt` is the next allowed moment. This handles daylight-saving changes.
  - An unknown timezone withholds push.
- **One briefing per local day:** a second briefing that day gets neither surface.
- **Dismissals:** `recordDismissal` stores timestamps per user and type. Three dismissals of a type within 7 days pause push for that type, with `resumeAt` set to when the third one ages out.
- **Retries:** a retry with the same candidate id resends only the surface that is still missing.
- **Push failures:** a push that returns false or throws gives `push: false`, a reason, and the in-app item still stored.
- **Shared state:** state is kept in one JSON file per user in `STATE_DIR`, which is created if needed. Each user has a lock directory, with stale-lock recovery. A worker that cannot get the lock within 30 seconds returns a "try again" result instead of sending.

## Choices I made that you may want to change

- **Consent keys:** you didn't name the purposes in the consents object, so I used `push`, `notifications`, and the card type.
- **Thresholds:** the 07:00 start, 11:00 briefing cutoff, 22:00 quiet hours, and the 3-in-7-days rule are my own choices. They are constants at the top of the file.
- **No "yes" means no push:** I read a missing category as "never asked", so no push goes out until the user opts in.
