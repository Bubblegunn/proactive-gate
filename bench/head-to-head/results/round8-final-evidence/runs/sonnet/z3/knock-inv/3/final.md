`bot.mjs` is written and its 7 tests pass. It exports `deliver` and `recordDismissal`, needs no dependencies, and I left `package.json` unchanged. The tests are in `bot.test.mjs`, with a helper `bot.worker.mjs` for the multi-process test. They use fake transports and a temporary state directory, so nothing real was sent.

**Rules, checked in this order**
1. **Category off:** `categories[type] === false` withholds both push and in-app. `resumeAt` is null.
2. **Snooze:** an active `snoozedUntil` withholds both. `resumeAt` is the later of the snooze end and the next morning window.
3. **Morning window:** the briefing goes out 07:00–11:00 in the user's timezone. Outside that, both surfaces are withheld and `resumeAt` is the next 07:00 local, as UTC ISO. Other card types may push 07:00–22:00.
4. **Push gates:** push is held back, but the in-app item is still stored, when any of these applies:
   - The category was never switched on in settings (missing counts as not opted in).
   - `notificationsPermitted === false`.
   - Consent is missing, or the consent store throws (fails closed).
   - The user dismissed that card type 3 or more times in 7 days.
   - A push of that type already went out today.

   `transport.push` returning false, or throwing, gives `push: false` with a reason.
5. **Idempotent retries:** a repeated `candidate.id` does not resend a surface that was already delivered. It still reports that surface as true.
6. **Shared state:** state is kept per user in `STATE_DIR` and written atomically. A lock file per user lets several worker processes share it, and a lock left by a crashed process is cleared. The test with 6 concurrent processes on one candidate produced exactly one push.

**Guesses you may want to change**
- **Consent key:** the spec doesn't name the purpose key, so push needs `consents.push === true` (or `consents[type] === true`), and an explicit false on either blocks it.
- **Window hours:** 07:00 is the wake time and 11:00 is when the briefing counts as stale. Both are constants at the top of the file.
- **Dismissal back-off:** the 3-in-7-days threshold is my own choice. It only pauses push, so the in-app card still appears.
