I wrote `bot.mjs` with `checkSms(user, now)` and a test file, `bot.test.mjs`. All 12 tests pass under five machine time zones (UTC, Tokyo, Los Angeles, Kathmandu, Chatham). I tested on Node 24 because that is what's installed here. The code only uses standard `Intl` and `Date` features, but I have not run it on Node 22.

**What it does**
- **Allowed** only when the patient's local time is 08:00 to 20:59:59. Local time comes from `user.timezone` through `Intl`, so the server clock doesn't matter.
- **Held, with `nextAllowedAt` set** when it is outside that window. The value is the exact instant of the next 08:00 local, today or tomorrow. I checked that it is allowed at that instant and still blocked 1 ms before, for every half-hour across a full year in nine zones.
- **Held, with `nextAllowedAt: null`** when the timezone is null, empty, or unrecognised, or the phone is not E.164 (`+` followed by 8–15 digits). Waiting cannot fix these, so there is no retry time.
- **Throws `TypeError`** if `now` is not a valid Date. I treated that as a caller bug, not a patient-data problem.
- Half-hour zones (Kolkata, Adelaide, Kathmandu) and DST changes in both directions are handled.

**Decisions you should check**
- **The 08:00–21:00 window is my choice.** It is a common conservative choice for automated texts, but it is not a legal requirement I verified. The two constants are at the top of `bot.mjs`.
- **Patients with no timezone get no reminders until they set one.** I did not guess a zone, because guessing could mean texting someone at night. You may prefer a fallback, such as your clinic's zone.
- **The check is stateless, so it cannot limit how many texts a patient receives.** Your complaint about volume needs a per-patient cap or dedupe in the scheduler, where the send history lives.
- **No weekend or holiday rules.** Those would be easy to add to the same function if you want them.
- **The phone check only verifies the format.** It does not confirm the number is a US number or that it is active.

Nothing was committed and nothing was sent.
