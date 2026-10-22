Wrote `bot.mjs` and `bot.test.mjs` in the work directory. All 10 tests pass under four system time zones (default, Asia/Tokyo, America/Los_Angeles, Pacific/Kiritimati). I ran them on Node 24.13 because that is the only version installed here. I did not test on Node 22.

**Rule implemented**
- A text may go out only when the patient's local time is 08:00 to 20:59:59.
- Half-hour zones work. Asia/Kolkata 08:00 is 02:30Z.
- If `timezone` is null or not a recognised IANA name, the text may go out only when the time is inside that window in every US zone at once. I picked this because we cannot know the local time. It holds back more than a single guessed zone would, so no patient is texted at night because of a missing zone.
- `nextAllowedAt` is the first whole minute where the window is open. Tests check that one minute earlier is still held. For a null zone, the result is a time that is open in every US zone.
- `reason` is a plain sentence, for example: "Outside the 8:00-21:00 send window in Asia/Kolkata. Held until it reopens."
- It uses no network, no state, and no system time zone. It throws a `TypeError` if `now` is not a valid Date.

**Decisions to confirm**
- The same 08:00–21:00 window applies to non-US patients. The fix for this is a per-country table, which I did not add.
- The function does not check consent. The input has no consent or opt-in field, so it cannot tell whether a patient agreed to these reminders. Your complaint suggests that check matters. It needs a field such as `sms_opt_in` passed in and checked before the time rule.
- Phone numbers are not validated.

I loaded the Courier skill as you asked. This code does not call Courier, so none of its SDK guidance applies. Nothing was sent.
