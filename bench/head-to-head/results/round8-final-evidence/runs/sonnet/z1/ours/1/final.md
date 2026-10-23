`bot.mjs` is written and works. It has no dependencies, so there is no `package.json` change. I ran one script against a temporary `STATE_DIR` and every case below behaved as intended.

**What `decide` checks, in order:**
1. **Kill switch.** It holds everything when `flags.proactiveEnabled` is not true.
2. **Opt-out.** An opt-out recorded by `optOut` blocks that type for that user, in every worker, until the end. The app gave me no function to turn a type back on, so there is no way back from an opt-out.
3. **Redelivery.** A notification id that was already sent returns `send: true` again. It does not spend the daily limit twice.
4. **Consent.** `consents.marketing` must be exactly `true`. A missing, empty or false value holds the notification. I chose `marketing` as the purpose for check-ins and tips because the task did not name one for them. If you want a different purpose, it is one line to change.
5. **Time zone.** It uses `deviceTimezone` first, then `timezone`. Missing, invalid and placeholder zones ("UTC", "GMT") are held. It never guesses a zone.
6. **Dismissal cooldown.** A dismissal pauses that type for 2 days, doubling with each further dismissal (4, 8, then 14 days at most).
7. **Daily limit.** It allows at most 1 notification per type per user per day in the user's local time. It claims the id first, then spends the limit atomically, so concurrent workers cannot both win.

A held result includes a plain reason, the retry time in the user's local clock with the zone name, and `nextAllowedAt` (epoch milliseconds) where there is a retry time.

**Numbers I chose:** 1 per type per local day, a 2-day cooldown base, and a 14-day cooldown cap.

**What I tested:**
- A first send was allowed.
- A repeat of the same id was allowed without spending the limit again.
- A second id the same day was held with a retry time.
- An id the next day was allowed.
- A missing consent was held.
- A "UTC" placeholder zone was held.
- The kill switch held.
- A dismissed type was held.
- An opted-out type was held.
- Five concurrent calls produced exactly one send.
- The daily limit still held after a fresh process started on the same `STATE_DIR`.

**Not checked:** other time zones and the daylight-saving shift (only Asia/Tokyo and the placeholder case ran), and a crash between claiming an id and finishing.

**Decisions for you:**
- **Quiet hours:** I added none, because you did not state any. A 03:00 local check-in is therefore allowed if the daily limit and consent pass. If you want quiet hours, name the window and I'll add it.
- **Cooldown reset:** nothing resets the dismissal cooldown, because the app gives me no "user acted" signal. Dismissals only escalate.
