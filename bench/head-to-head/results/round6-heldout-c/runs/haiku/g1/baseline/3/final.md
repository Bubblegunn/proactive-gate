I wrote `bot.mjs` in the working directory. It exports `checkSms(user, now)`, and the tests pass. Nothing was sent and nothing was committed.

**Rules I chose (please confirm):**
- **Send window:** 08:00 inclusive to 21:00 exclusive, on the patient's local clock. This is my choice, not something you specified. It is the usual conservative reading of US "8am–9pm" limits, but check it against your compliance advice.
- **No valid time zone** (null, empty, unknown, or an offset like `+05:00`): blocked, `nextAllowedAt: null`. I did not fall back to a default zone, because that could text someone at night.
- **Phone not in E.164 format** (`+` then 7–15 digits): blocked, `nextAllowedAt: null`.
- **Invalid `now`:** throws `TypeError`, so the scheduler fails loudly instead of guessing.
- **Weekends and holidays:** not checked.

**How the retry time is computed:** The window's start is found in the patient's zone, then converted to a UTC instant. This handles DST changes and half-hour offsets. `nextAllowedAt` is the exact first allowed instant, never earlier.

**Not covered:** The function gets no opt-out or STOP status, so it cannot honor a patient who has opted out. Your SMS vendor or scheduler has to check that before calling this. Given the earlier complaint, I'd treat that as a priority.

**Verification** (run from a scratch directory, since removed):
- Fixed cases: the 08:00 and 21:00 boundaries, the Chicago fall-back and spring-forward transitions, Kolkata (+05:30), Adelaide (+10:30 DST), and bad inputs.
- Property check: about 156k instants across 14 zones over all of 2026. Every blocked result is allowed at `nextAllowedAt` and still blocked 1 ms before it.
- Same results with the machine clock set to Tokyo and to Kiritimati.

Sample output:
```
{ allowed: false, reason: 'Local time for this patient is 22:00 in America/Chicago. Texts are sent only between 08:00 and 21:00 local time. The window next opens at 2026-10-23T13:00:00.000Z.', nextAllowedAt: 2026-10-23T13:00:00.000Z }
```
