`bot.mjs` is written and exports `checkSms(message, now)`. A 14-case check passed, run with the server clock set to Asia/Tokyo so server time zone was shown not to matter. I did not send anything.

**Rules in the order they are checked**

| Code | Applies to | Rule |
|---|---|---|
| `invalid_now`, `invalid_message`, `invalid_kind` | both | Bad input is held, never guessed. |
| `invalid_phone` | both | The number must be a valid US E.164 number (`+1`, then a 10-digit number that does not start with 0 or 1 in the area code or exchange). |
| `opted_out` | marketing | Any non-null `optedOutAt` blocks, including an unparsable string. This follows revocation of consent in 47 CFR 64.1200(a)(10) and the CTIA STOP principle. |
| `no_marketing_consent` | marketing | Only `marketingConsent === true` passes. A missing or false value blocks. This follows the prior-express-written-consent rule in 64.1200(a)(2). |
| `invalid_time_zone` | marketing | The window can't be checked, so the text is held. |
| `quiet_hours` | marketing | Local time must be at or after 08:00 and before 21:00 in the customer's `timeZone`. This follows 64.1200(c)(1). It uses `Intl` with the IANA zone, so DST is handled. |

Transactional texts need only a valid message and a valid US number. They are not solicitations, so consent, STOP and the 8am–9pm window don't apply to them. A customer who replied STOP to marketing still gets login codes and delivery updates.

**Cases the check covered**
- Boundaries: 07:59, 08:00, 20:59 and 21:00 local.
- Both summer and winter offsets.
- Missing consent.
- STOP.
- A bad zone.
- A bad phone number.
- A bad kind.
- A transactional text at 3am with no consent and a STOP on file (allowed).
- A normal marketing text (allowed).

**What your lawyers should know**
- **Assumption on transactional texts:** I treated a STOP as covering marketing only. If counsel reads the 2024 FCC revocation rule as covering every automated text from you, the transactional branch needs an opt-out check.
- **Home zone:** the 8am–9pm check uses the home `timeZone` from the profile. If the customer is traveling, the rule technically applies at their actual location, which this function can't see.
- **Not enforced: opt-out and "Msg&data rates" wording in the body.** CTIA asks for it in a program's first message. The function can't tell whether a message is the first, so it never blocks on body content. Add that check where you know the enrollment state.
- **Not covered:** frequency caps, state "mini-TCPA" rules such as Florida's and Oklahoma's stricter hours, and the national Do-Not-Call list. I didn't add them because you didn't ask and the function keeps no state.
