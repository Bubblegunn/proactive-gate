`bot.mjs` is written and checked. It needs no dependencies, so `package.json` is unchanged. My test script ran every scenario below and printed the results, and a 12-process run confirmed the shared state. I deleted the script afterwards.

**What it decides**
- **Category off** (`categories[type] === false`): nothing goes out, push or in-app, and `resumeAt` is null.
- **Snoozed:** nothing goes out, and `resumeAt` is `snoozedUntil`.
- **No push, in-app still stored:**
  - the category is missing (never asked);
  - `notificationsPermitted` is false;
  - the transport returns false.
- **Briefing push window:** 07:00 to 10:00 in the user's timezone. Outside it, `resumeAt` is the next 07:00 local, and the DST case checked correct (New York, 1 Nov).
- **Other card types:** no push from 22:00 to 07:00 local.
- **Consent:** if `consentStore.get` throws, or returns something that isn't an object, there is no push.
- **At most one briefing push per user per local day.** A second briefing the same day is withheld completely.
- **Duplicates by `candidate.id`:** a second attempt is a no-op. If the earlier attempt only stored the in-app item, a later retry sends just the push.
- **Dismissals:** `recordDismissal` stores each swipe. After 3 swipes of one type within 7 days, push for that type pauses. The in-app item still arrives, and `resumeAt` is when the count drops below 3.

**Sharing and restarts:** each user has one JSON file and one lock directory in `STATE_DIR`. Writes are atomic with fsync, so state survives a restart. A delivery is claimed under the lock before anything is sent, so concurrent workers can't double-send. A claim from a crashed worker expires after 10 minutes.

**Checks run**
- 12 separate processes with the same candidate produced exactly one push and one in-app item.
- State persisted across processes.
- Every case in the lists above produced the result described, including a push-only retry after the window opened and a push going out again once the dismissal pause ended.

**Guesses you should confirm**
- **Windows:** the 07:00–10:00 briefing window, the 22:00–07:00 quiet hours and the 3-swipes-in-7-days rule are my choices; the spec gave no numbers.
- **Consent keys:** the spec doesn't name the consent purposes. I treat `consents.push === false` or `consents.notifications === false` as a refusal, and a missing key as allowed.
- **Missing category means no push:** a user who was never asked gets only the in-app item.
- **`STATE_DIR`:** `deliver` throws if it isn't set.
