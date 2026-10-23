`bot.mjs` is written and works in my checks. It exports `deliver` and `recordDismissal`. It has no dependencies, so `package.json` is unchanged. I tested it with fake transport and consent stores and sent nothing real. I did not save any memory notes.

**What the checks showed**
- **Races:** 12 worker processes delivering the same briefing at once sent exactly one push and one in-app item, and all 12 returned `push: true, inApp: true`.
- **Outcomes:** each of these gave the expected `push`, `inApp`, `reason` and `resumeAt` values:
  - Too early for the user's timezone.
  - Past the morning window.
  - Snoozed.
  - Category off.
  - Category never asked.
  - Phone permission off.
  - Consent store down.
  - Push rejected.
  - Dismissal pause.
  - Same briefing retried.
  - Second briefing on the same day.
- **Retry after a rejected push:** a push the phone rejected can be retried later without a duplicate in-app item.

**How it behaves**
- **Timing:** a briefing push goes out between 07:00 and 11:00 in the user's timezone. Before 07:00 it waits until 07:00. After 11:00 it moves to the next morning, because the briefing would be stale. Other card types are blocked from 22:00 to 07:00.
- **Snooze:** a snoozed user gets nothing on either surface. `resumeAt` is the snooze end, moved forward to the next allowed push time if the snooze ends at night.
- **Category switched off:** nothing is sent. No `resumeAt` is given.
- **Category missing:** the in-app item is stored, but no push is sent.
- **Push withheld, in-app kept:**
  - Phone permission is `false`.
  - Consent has `push` or `notifications` set to `false`.
  - Consent has `marketing` set to `false` (non-briefing types only).
  - The consent store throws.
  - The timezone is invalid.
- **Duplicates:** the same candidate id is never pushed or stored in-app twice. Retries return the earlier result. Only one briefing push goes out per local day.
- **Dismissals:** `recordDismissal` counts swipes per user and type. After 3 swipes of one type within 7 days, pushes of that type pause and `resumeAt` is set.
- **State:** it lives in `STATE_DIR`, one file per user, written atomically with a lock file so several processes can share it. It survives a restart.

**Rules I chose because the spec didn't say**
- The consent purpose names (`push`, `notifications`, `marketing`) are my guess.
- The 07:00–11:00 window, the 3-dismissals-in-7-days rule and the one-briefing-per-day cap are my choices. All are constants at the top of the file.
- I treated a missing category as "never asked", so it gets no push.

If your app uses different consent names or windows, change those constants and the consent check.
