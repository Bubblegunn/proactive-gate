I wrote `bot.mjs` with `checkSms(message, now)`. I tested it with 18 cases, run with the server zone set to UTC and to Pacific/Auckland. All 18 passed in both runs. Nothing is sent. The test script is in `/tmp`, not in the repo.

**Rules, in the order they are checked**

| Applies to | Reason code | Blocks when | Legal basis |
|---|---|---|---|
| Both | `invalid_message` | Input is malformed, the kind is unknown, or `now` is not a valid date. | Fails closed. |
| Both | `invalid_phone_number` | The phone is not `+1` followed by 10 digits with a valid area code and exchange. | Not a legal rule. We can't send to a bad number. |
| Both | `empty_body` | The body is blank. | Not a legal rule. |
| Marketing | `marketing_opted_out` | `optedOutAt` is set. | CTIA requires honoring STOP. 47 CFR 64.1200(a)(10) requires honoring revocation of consent. |
| Marketing | `invalid_opt_out_timestamp` | `optedOutAt` is set but can't be parsed. | Fails closed. |
| Marketing | `no_marketing_consent` | `marketingConsent` is not exactly `true`. | 64.1200(a)(2) requires prior express written consent. CTIA requires opt-in. |
| Marketing | `invalid_time_zone` | `timeZone` is not a valid IANA zone. | Fails closed. |
| Marketing | `quiet_hours` | The customer's local time is before 08:00 or at or after 21:00. | 64.1200(c)(1). |

- **Opt-out check:** any non-null `optedOutAt` blocks marketing, including a future timestamp. We can't verify when the STOP reply came.
- **Quiet hours:** local time comes from the customer's `timeZone` using `Intl`, so DST is handled. I block from 21:00:00 exactly, which is slightly stricter than the rule's "after 9 p.m."
- **Transactional texts:** they skip the consent, opt-out and quiet-hours rules. They are not telephone solicitations, so a login code at 3 a.m. goes out.

**Decisions for your lawyers**
- **STOP and transactional texts:** a STOP reply blocks marketing only. Transactional texts still go out after STOP, because otherwise a customer who replied STOP can't log in. This is my reading, so please have your lawyers confirm it. The FCC's broader "revoke all" rule has been delayed. Check its current status.
- **Opt-out wording not required:** I don't require "Reply STOP" in marketing bodies. CTIA asks for that wording in the first message and periodically, and the function has no send history to know which message is first.
- **Rules not covered:** the function does not handle stricter state laws (Florida and Oklahoma end at 8 p.m., for example), the customer's actual location when away from home, frequency limits, or promotional content inside a "transactional" text. Those rules need data the function doesn't receive.
