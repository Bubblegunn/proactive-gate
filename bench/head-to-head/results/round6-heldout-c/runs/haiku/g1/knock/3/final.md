`bot.mjs` is written in the work directory and exports `checkSms(user, now)`. It allows a text only when the patient's local time is between 09:00 and 20:00, and otherwise returns the next 09:00 local as `nextAllowedAt`. All 13 test groups pass under three different machine time zones. I have not committed anything.

Choices I made that you should confirm:

- **Window is 09:00 to 20:00 local time**, with 20:00 itself held. The window is a constant at the top of the file. A stricter 09:00–18:00 would be a one-line change.
- **Missing or unrecognised time zone (null, empty, or an unknown name) is held with `nextAllowedAt: null`.** Local hours can't be verified, and the patient may never set a zone, so there is no honest retry time. The scheduler will keep holding these until someone fixes the zone.
- **An invalid `now` is also held** with `nextAllowedAt: null`. That is the safe default if the scheduler passes a bad value.
- **Half-hour and 45-minute zones** (Kolkata, Kathmandu) are handled from the zone's real offset, not from whole hours.
- **DST changes** are handled. The tests cover the March and November transitions for New York.

How I checked it:

- **Hand-picked cases:** boundaries at 08:59, 09:00, 19:59 and 20:00, both half-hour zones, both DST days, and the null/unknown/invalid inputs.
- **Property sweep:** about 2,000 held results across 10 zones over 40 days including both DST changes. Each `nextAllowedAt` is the first open minute, sampled every 10 minutes between now and that time.
- **Machine zone independence:** the suite passed with `TZ` set to Auckland, Los Angeles and UTC.
- **Node version:** only Node 24 is installed here, so the Node 22 target is unverified. The code uses only long-standing Intl and Date features, but please run it on Node 22 before relying on it.

Not covered, and worth deciding before go-live given the complaint:

- The function does not check that the patient opted in to reminder texts. The app has to do that before the scheduler calls it.
- There is no frequency cap, so a patient can still get several texts in one day.
- Weekends and holidays are not excluded.
- The phone number is not validated.

I can add any of these if you tell me the rules you want.
