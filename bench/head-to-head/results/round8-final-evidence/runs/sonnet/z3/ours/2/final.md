`<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round8-final/z-sonnet/work/ours-z3-2/bot.mjs` is written. It exports `deliver` and `recordDismissal`, needs no dependencies, and runs on Node 22.

I checked it with one script covering these cases:
- **Normal send:** a briefing at 07:30 local goes out on both push and in-app.
- **Redelivery:** the same message id sends nothing twice and returns the same answer.
- **Early hour:** a 03:00 attempt withholds push, still stores the in-app item, and returns `resumeAt` of 07:00 local.
- **Snooze:** push is held until `snoozedUntil`, and `resumeAt` is that moment.
- **Category off:** both surfaces are held.
- **Consent store down:** both surfaces are held.
- **Invalid time zone:** push is held.
- **Swipe-away:** a dismissed card type is held for the rest of that day.

I did not run it with several worker processes at once. The shared state uses atomic claims and writes, but two workers racing on one message id is untested. I also did not test a restart, an in-app transport failure, a push transport error, or the 04:00 to 05:00 DST edge.

**Numbers I chose:**
- Push goes out only between 07:00 and 11:00 in the user's local time. 07:00 is included and 11:00 is not. "When people wake up" gave no exact time, so this is my reading.
- A swiped-away card type is held until the end of the user's local day.

**Behaviour you might not expect:**
- **Consent key:** I read consent from `consents[candidate.type]`, since you named no purposes. A missing or false value means off, and a store error holds everything.
- **Category off:** `categories[type] === false` holds both push and in-app. A missing category does not block, because the consent store already decides.
- **Snooze, hours, permission and zone:** these hold push only. The silent in-app item is still stored, since it doesn't interrupt anyone. If you want snooze to hide the in-app item too, say so.
- **`notificationsPermitted`:** `false` holds push. A missing value still tries the push.
- **`recordDismissal`:** it stores the time of the swipe, and `deliver` then holds that card type until the end of that user's local day. You didn't specify what a dismissal should do, so this is my addition. It applies to every type, briefing included.
- **Per-surface claims:** each surface is claimed per user and message id. A push held earlier can still go out on a later attempt with the same id, and the in-app item is not stored twice. A push the phone rejects gives its claim back. A transport error keeps the claim, because the outcome is unknown.
- **State directory:** `STATE_DIR` is read on every call. If it is unset, the code falls back to `./.state`.

I enforce no check on the notification text itself, and none on `platform`.
