`bot.mjs` is written at `work/ours-g1-3/bot.mjs`. It exports `checkSms(user, now)` with no dependencies, no state, and no network. My checks pass under four different machine time zones, and nothing was sent.

**Rules I chose (you should confirm these):**
- **Send window:** 08:00 to 21:00 in the patient's local time, with 08:00 inclusive and 21:00 exclusive. The limits are constants at the top of the file. I chose this as a conservative US window for texts, but I have not checked it against your compliance requirements or state rules.
- **Before 08:00 local:** `nextAllowedAt` is 08:00 local today. At or after 21:00: 08:00 local tomorrow. The time is exact, so the scheduler never retries early.
- **Missing, empty, or unrecognised time zone:** blocked, `nextAllowedAt: null`. I did not guess a zone, because a guess could text someone at night.
- **Phone not in E.164 format** (for example `+13125550142`): blocked, `nextAllowedAt: null`.
- **Invalid `now` or missing user:** blocked, `nextAllowedAt: null`. The function does not throw.

**Checks I ran** (in `/tmp/checksms-test/check.mjs`, outside the repo):
- Fixed cases: 07:59:59.999 is held until exactly 08:00:00.000; 20:59:59.999 is allowed; 21:00 is held until the next morning.
- Half-hour zones (Kolkata, Kathmandu, St. John's) and DST changes in Chicago (spring forward and fall back).
- Bad zone, missing zone, bad phone, and bad `now`.
- A minute-by-minute sweep over 4 days in 10 zones (172,800 samples). Each result matches the local-hour rule, and each held result's `nextAllowedAt` is allowed while the millisecond before it is not.

**What this does not cover:**
- **Consent and opt-outs.** The user object has only `id`, `phone`, and `timezone`, and the function has no state. It cannot see STOP replies, opt-outs, or how many texts a patient has already received. If you want those checks, the data has to come in as input or from your database. That is probably the fix for the complaint, not the time window alone.
