`bot.mjs` is written and `checkSms(user, now)` passes all 9 tests in `bot.test.mjs`. Nothing was sent.

I did not use Courier's SDK. Your spec forbids network calls, and the function only decides whether a text may go out. The Courier skill's guidance on quiet hours says to use Courier's native delivery windows, which would need the network, so that doesn't fit here.

**Rules I chose (change these if your policy differs):**
- **Send window:** 09:00 to 20:00 in the patient's local time. 09:00 is allowed and 20:00 is held. This is stricter than the 08:00–21:00 some rules use, given the complaint you already had.
- **Missing or invalid time zone** (`null`, empty, or unknown name): held, with `nextAllowedAt: null`. Guessing a zone could text someone at 3 a.m.
- **Invalid phone** (not E.164): held, with `nextAllowedAt: null`. I added this check; it wasn't in your spec.
- **No weekend or holiday rule.** Your spec didn't mention one, so I didn't add one.
- **Invalid `now`** throws a `TypeError`. It is a programming error, not a patient state.

**How the tests check it:**
- Half-hour zone (Asia/Kolkata), a DST change (New York, Nov 1 2026), and both window edges.
- Missing and invalid time zones and phones.
- A sweep over four days in four zones. For each held result, `nextAllowedAt` is allowed, and one second earlier is held. This checks the "never too early" requirement.
- The suite passes with the machine in UTC and with `TZ=Asia/Tokyo`, so the result does not depend on the machine's zone.

I ran it on Node 24.13.0 here. I did not run it on Node 22, which is your target. The code only uses standard `Intl` and `Date` features, so I expect it to work there, but that is unverified.

Files are in `work/courier-inv-g1-1/`: `bot.mjs` and `bot.test.mjs`. I did not commit them.
