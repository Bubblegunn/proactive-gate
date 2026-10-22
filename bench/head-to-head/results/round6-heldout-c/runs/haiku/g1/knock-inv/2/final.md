`bot.mjs` is written and passes its tests. Nothing was sent.

**Files** (in `work/knock-inv-g1-2/`)
- `bot.mjs`: exports `checkSms(user, now)`. Synchronous, no state, no network.
- `bot.test.mjs`: 12 tests, run with `node --test bot.test.mjs`. All pass, and they also pass under `TZ=UTC`, `Asia/Tokyo`, `America/Los_Angeles`, and `Australia/Sydney`.

**Rules I chose** (the skill's guidance on quiet hours and TCPA is general, so these numbers are mine)
- A text may go out only between **08:00 and 20:00** in the patient's time zone. The end is stricter than the 9 pm TCPA limit, which fits the one complaint you already have.
- If the patient's time is outside that window, `nextAllowedAt` is the exact instant of the next 08:00 local. Before 08:00 that is today; from 20:00 on it is tomorrow. The tests check that one second earlier is still held and the instant itself is allowed, across two months and eight zones, including the US DST changes and the half-hour zones Kolkata, Kathmandu, and Adelaide.
- A `null`, empty, or unrecognised time zone returns `allowed: false` with `nextAllowedAt: null`. I chose to hold these rather than guess a zone. The cost is that patients without a saved zone get no reminders until they set one.
- A missing phone number is also held with `nextAllowedAt: null`.
- An invalid `now` throws a `TypeError`.
- The `reason` text never includes the phone number.

**Gaps you should decide on**
- **Consent and opt-out are not checked.** The function only gets `id`, `phone`, and `timezone`. The skill says TCPA requires consent records and that opt-outs must be honored immediately. If you need that gate, the scheduler has to pass an opt-out flag, or this function needs a consent input.
- **Weekends and holidays are not restricted.** You didn't ask for it, so I didn't add it.
- **The `reason` text is English only.**

I did not commit anything.
