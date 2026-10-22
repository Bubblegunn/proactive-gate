`bot.mjs` is written and passes my checks. Its exports are `checkSms(message, now)`, which is synchronous and has no dependencies. Nothing is sent.

I ran about 20 assertions in `/tmp/bot-check/check.mjs`, once each with the server time zone set to UTC, America/Chicago and Asia/Tokyo. All passed, so the server zone does not affect results. The checks cover:
- **Quiet-hour boundaries:** 07:59:59 is blocked and 08:00 is allowed. 20:59:59 is allowed and 21:00 is blocked.
- **Daylight saving:** both summer and winter offsets, and the 2026-03-08 spring-forward day.
- **Other zones:** Los Angeles and Honolulu.
- **Opt-out, consent and bad input:** an opt-out, missing consent, a bad zone, a bad phone and a bad message.
- **Transactional texts:** they go through at any hour, even with no consent and after a STOP.

**Rules, for the lawyers**

| Reason code | Applies to | Rule |
|---|---|---|
| `opted_out` | marketing | A STOP reply revokes consent (47 CFR 64.1200(a)(10), CTIA). Any non-null `optedOutAt` blocks, with no grace period. The FCC allows up to 10 business days, but we stop at once. |
| `no_marketing_consent` | marketing | An autodialed or AI-triggered marketing text needs prior express written consent (64.1200(a)(2)). Only `marketingConsent === true` passes. |
| `quiet_hours` | marketing | No telephone solicitation before 8 a.m. or after 9 p.m. at the called party's location (64.1200(c)(1)). The function uses the profile's home zone. |
| `invalid_time_zone` | marketing | The zone is missing or not valid, so the function blocks because it cannot show the time is allowed. |
| `invalid_message`, `invalid_phone`, `invalid_time` | all | Malformed input: bad kind, empty body, missing recipient, a phone number that is not E.164, or an invalid `now`. |

For marketing, the checks run in this order: opt-out, then consent, then quiet hours.

**Decisions to confirm with your lawyers**
- **STOP and transactional texts:** a STOP reply does not block transactional texts, and they have no time window. I treated them as texts the customer asked for in the app, so consent and quiet hours do not apply. If your counsel reads STOP as covering every text, add an opt-out check before the transactional return in `checkSms`.
- **Re-consent after STOP:** the profile has no consent date, so a customer who opts in again after STOP stays blocked until `optedOutAt` is cleared.
- **9 p.m. cutoff:** I block from 21:00:00, which is slightly stricter than "after 9 p.m."
- **Promotional content in transactional texts:** the function cannot detect it. A promotion inside a delivery update makes it marketing, so the caller must classify the kind correctly.

**Not checked, because the function has no data for them:**
- the National Do-Not-Call list and your own do-not-call lists
- stricter state rules, such as shorter quiet hours in Florida, Oklahoma or Maryland
- opt-out wording in the message body, such as "Reply STOP"
- sender identification and carrier (10DLC) registration
- a customer who is away from their home zone

If you want, I can add the "Reply STOP" body check for marketing texts.
