`<HOME>/.../knock-inv-z3-1/bot.mjs` is written. It has no dependencies and `package.json` is unchanged.

I tested it with a fake transport and consent store, including 8 separate Node processes sharing one `STATE_DIR`. Each scenario below behaved as described. I did not write a test file, and the check script is in `/tmp/botcheck`.

**How the briefing is gated**

- **Category off:** if `categories.briefing` is `false`, or consent for that type is `false`, nothing is sent on either surface.
- **Snooze:** while `snoozedUntil` is in the future, nothing is sent. `resumeAt` is the end of the snooze, moved to the next 07:00 local time if that falls in quiet hours.
- **Quiet hours:** from 22:00 to 07:00 in the user's timezone the push is held but the in-app item is still stored. `resumeAt` is the next 07:00 local time, which handles daylight saving.
- **Push needs an explicit opt-in:** `categories.briefing` must be `true`. A missing value counts as never asked, so only the in-app item goes out.
- **Other push blocks:**
  - The consent store throws.
  - `consents.push` or `consents.notifications` is `false`.
  - `notificationsPermitted` is `false`.
  - The timezone is missing or invalid.
  - In each case the push is held and the in-app item is still stored.
- **Failed push:** if `transport.push` returns false or throws, the in-app item is stored instead and the reason says so.
- **Dismissals:** after 3 swipes of the same type within 7 days, push for that type pauses. `resumeAt` is when the third-newest swipe leaves the 7-day window.
- **Once per day:** there is one briefing push per user per local day. A retry of the same `candidate.id` is also skipped, so a repeat call returns `push: false`, `inApp: false` and the reason "This briefing was already sent."

State is stored as one JSON file per user in `STATE_DIR`, written atomically and guarded by a lock directory. In the 8-process test the shared candidate got exactly one push and one in-app item.

**Choices I made where your spec was silent**

- Quiet hours (22:00 to 07:00) and the 3-in-7-days dismissal rule are my picks. They are constants at the top of the file.
- A push claimed by a worker that crashes mid-send is lost; a claim older than 2 minutes can be retried.
- A snooze or an off category blocks the in-app item too, but quiet hours and the other push blocks leave it in.
