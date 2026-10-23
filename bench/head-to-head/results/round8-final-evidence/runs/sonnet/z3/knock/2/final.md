`bot.mjs` is written and checked. It needs no dependencies, so `package.json` is unchanged.

**What I ran**
- 11 scenario checks passed, covering normal delivery, duplicate retry, a second briefing the same day, too early, snooze, category off, never asked, OS permission off, no device token, consent store down and dismissal fatigue.
- I ran 8 worker processes against one `STATE_DIR` with different candidate ids. Exactly one push went out. State is saved to disk per user, so it survives a restart.

**Rules I chose** (your spec left these open, so check them)
- **Briefing window:** push goes out only 07:00–10:00 in the user's timezone. Outside that window nothing is sent, and `resumeAt` is the next 07:00.
- **Once per day:** only one briefing per local day.
- **Other card types:** push only 08:00–21:00, with at most 3 pushes a day.
- **Category off:** an explicit `false` withholds both surfaces.
- **Category missing:** the user is treated as never asked, so only the in-app item goes out and there is no push.
- **Snooze:** an active snooze withholds both surfaces. `resumeAt` is the snooze end, moved to the next allowed time.
- **OS permission:** if `notificationsPermitted` is `false`, there is no push, but the in-app item still goes out.
- **Push rejected:** if `transport.push` returns false, the in-app item still goes out and `reason` says so.
- **Consent:** I didn't know your purpose keys. An explicit `false` on the card type, `notifications` or `push` withholds both surfaces. Missing keys are treated as allowed. If the consent store throws, nothing is sent.
- **Dismissals:** 3 dismissals of a type within 14 days pause push for that type. The in-app item still goes out. `resumeAt` is when the oldest of those three ages out.
- **Duplicates:** the same `candidate.id` is never delivered twice. A claim that crashed mid-send can be retried after 10 minutes.
- **Bad input:** an invalid timezone or an unreadable `snoozedUntil` withholds both surfaces.
