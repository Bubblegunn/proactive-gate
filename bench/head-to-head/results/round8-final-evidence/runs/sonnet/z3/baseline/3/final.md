`bot.mjs` is written and passes my checks. It has no dependencies, so `package.json` is unchanged. The check was a throwaway script in `/tmp/botcheck`, not in the project folder.

The checks I ran:
- A push goes out at 08:00 local time.
- A second attempt with the same `candidate.id` does not push again and still reports the in-app item.
- At 05:00 local time the push waits, and `resumeAt` is that day's 07:00 local time as a UTC string.
- Snooze, category off, consent store down, OS permission off, and the phone rejecting the push all behave as described below.
- Three dismissals pause push, with the correct `resumeAt`.
- 8 separate processes delivering the same briefing to the same user produced exactly 1 push.

Rules I chose, since your spec left them open:
- **Waking hours:** push is allowed from 07:00 to 22:00 in the user's time zone. Outside that, it waits and `resumeAt` is the next 07:00.
- **Snooze and waking hours:** these withhold the push but still store the in-app item.
- **Category set to `false`:** nothing is sent, neither push nor in-app.
- **Category missing (never asked):** in-app only, no push.
- **Consent:** push needs a `true` among the `push`, `notifications` or type keys, and none of them `false`. If the store throws, push is withheld and the in-app item still goes. Your spec didn't name the purpose key, so check this against your real consents object.
- **OS permission:** `notificationsPermitted === false` blocks push. A missing value still tries the push.
- **Dismissals:** 3 dismissals of one type within 7 days pause push for that type. `resumeAt` is when the count drops below 3.
- **Daily cap:** one push per user per type per local day.
- **Retries:** a retry for the same `candidate.id` never duplicates the in-app item or the push.
- **Unreadable state or lock:** if the state can't be read or locked, nothing is sent and `reason` says to try again later.
- **Unknown time zone:** push is withheld, with `resumeAt` null.

`resumeAt` is only set when every reason for withholding the push is time-based. If a permanent blocker such as consent or a category that is off also applies, it stays null.

State is one JSON file per user in `STATE_DIR` (created if needed, `./.state` if unset), written atomically and guarded by a lock file so the workers don't clash. It survives restarts. A lock older than 30 seconds is treated as stale and removed.

I made no commit.
