`/bot.mjs` is written in the current folder and exports `deliver` and `recordDismissal`. It uses only Node built-ins, so `package.json` is unchanged. I ran it with a throwaway test script (kept outside the folder) and it behaved as listed below.

**What `deliver` does, in order**
1. **Category off:** if `categories[type] === false`, neither surface gets it, `reason` says so, and `resumeAt` is null. A missing `categories` or missing key counts as never asked, so it is not treated as an opt-out.
2. **Repeat candidate:** a `candidate.id` that was already delivered is not sent again. The result repeats the earlier `push` and `inApp` values, with a reason saying it was already delivered.
3. **Snooze and quiet hours:** if `snoozedUntil` is in the future, or the user's local time is between 22:00 and 07:00, nothing goes out. `resumeAt` is the later of the snooze end and the next 07:00 local, handling daylight saving. The 22:00 and 07:00 limits are my choice; the task didn't give them.
4. **One briefing per local day:** a second, different briefing the same day is withheld, with `resumeAt` set to the next morning.
5. **Push gates, in-app still delivered:** push is skipped if `notificationsPermitted === false`, if the timezone is missing or invalid, or after 3 dismissals of that type within 7 days. For the dismissal case, `resumeAt` is when the count drops below 3. Push is also skipped if consent is denied, or if the consent store throws or returns nothing, which means it fails closed. Denied means `push`, `notifications` or the type's own key is false. Those key names are my guess, since the task didn't name the consent purposes.
6. **Sending:** the in-app item is stored first, then `transport.push` is called. If push returns false or throws, you get `push: false`, `inApp: true` and a plain-sentence reason.

**Shared state**
- Each user has one JSON file in `STATE_DIR`, named by a hash of the user id.
- Workers coordinate through a per-user lock directory. The lock is released if its owner crashes (after 30 seconds), and files are written to a temp name and renamed so they survive a restart.
- `recordDismissal` uses the same lock.

**Checks I ran**
- The normal path returns push and in-app both true.
- Night and snooze return the correct `resumeAt`, converted from New York time.
- Category off, consent store down, push returning false, permission denied, three dismissals and an invalid timezone all behave as described above.
- Six separate processes calling at once for one user (candidates x, x, y, y, x, z) produced exactly one push.

I did not run a restart test or a crash-during-lock test.

**Choices to confirm**
- A snooze or quiet hours hold back the in-app item as well as the push. Say if you'd rather the in-app item still appear.
- If the process dies between sending and saving state, a retry could send a duplicate.
