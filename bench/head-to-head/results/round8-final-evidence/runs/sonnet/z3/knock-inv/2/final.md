`<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round8-final/z-sonnet/work/knock-inv-z3-2/bot.mjs` is written. I ran a check script against it and every case passed. That script is in `/tmp/botcheck`, not in the project. No dependencies were needed, so `package.json` is unchanged.

**What I chose.** The brief didn't set these, so change them if you disagree.
- **Briefing window:** 07:00 to 11:00 in the user's local time.
  - Outside it, nothing is sent, neither push nor in-app. `resumeAt` is the next 07:00 local, computed correctly across daylight-saving changes.
  - An unknown timezone also withholds the briefing, with `resumeAt` null.
- **Snooze:** nothing is sent until `snoozedUntil`. `resumeAt` is that time, moved to the next 07:00 if it falls outside the window.
- **Kinds switched off:** if `categories[type]` is false, neither surface gets it.
- **No choice made yet:** if `categories` or `categories[type]` is missing, the user gets the in-app item only, never a push.
- **Push is withheld, in-app still stored,** in these cases:
  - OS permission is false.
  - The consent store is down (it fails closed).
  - `consents.push` is false, or `consents[type]` is false.
  - The user swiped that type away 3 times within 14 days. `resumeAt` is when the third-newest swipe ages out.
  - For non-briefing cards only, local time is between 22:00 and 07:00.
- **Phone rejects the push:** `push` is false and the in-app item is stored.
- **`recordDismissal`:** this is what produces the "3 times in 14 days" rule above.
- **Duplicates:** one briefing per user per local day, and one delivery per card id for other types. A second attempt returns `{ push: false, inApp: false }` with a reason. If both transport calls throw, the claim is released and the error is rethrown, so a retry is possible.

**State.** State lives in `STATE_DIR`, which is created if missing.
- **Dismissals:** appended as lines to a per-user file.
- **Delivery claims:** created atomically, so two workers can't both claim the same delivery.
- **Crashed workers:** a claim left "pending" for more than 10 minutes is treated as dead and can be retaken. There is a very small race window if two workers retake it at the same instant.

**What I checked** (against a temporary `STATE_DIR`):
- Normal send, too early, too late, snooze (both inside and outside the window) and category off.
- Missing categories, OS permission false, phone rejecting the push, and the consent store being down.
- Duplicate attempts and the dismissal pause.
- The daylight-saving boundary in New York.
- 8 separate processes delivering for the same user at once: exactly one stored the in-app item.
