Wrote `bot.mjs` in the working directory. It exports `checkSms(message, now)` and passes all 36 checks in my test script, including under four different server time zones. Nothing was sent.

**Checks, in order** (first failure wins; each has its own reason code):

| Reason | Rule |
|---|---|
| `invalid_kind`, `invalid_body`, `invalid_phone`, `invalid_now` | Malformed input is blocked. Phone must be a US E.164 number. |
| `opted_out` | Any non-null `optedOutAt` blocks every kind of text. A STOP reply revokes consent for the sender, so this is the conservative reading. |
| `no_marketing_consent` | Marketing needs `marketingConsent === true`. This is the prior express written consent rule, 47 CFR 64.1200(a)(2). |
| `invalid_time_zone` | `timeZone` must be a valid IANA zone. |
| `outside_quiet_hours` | Marketing is blocked before 08:00 and from 21:00 on, in the customer's zone. This is 47 CFR 64.1200(c)(1). |
| `missing_opt_out_instructions` | Marketing body must contain "STOP". This follows the CTIA opt-out guidance. |

Transactional texts skip the consent, quiet-hours and opt-out-text checks. They are still blocked by `opted_out`. Quiet hours do not apply to them because they are not telephone solicitations.

**Things your lawyers should know:**
- The function trusts the `marketingConsent` boolean. It does not check the consent record itself (disclosure text, timestamp, channel). Keep that evidence elsewhere.
- Nothing in the input shows that a transactional text was customer-triggered. The function cannot verify that. Your caller must guarantee it.
- The rules are from my knowledge, not checked against the current text of 47 CFR 64.1200 or the CTIA principles. I did not search for them. Please have counsel confirm the citations.
- I did not add frequency caps or a check that a marketing message is not disguised as transactional. Both are outside what you asked for.

**Testing:** the tests are in `/tmp/sms-gate-test/test.mjs`, outside the project. The sandbox runs Node v24, not 22. The code uses only features that exist in Node 22, but I did not run it on Node 22.
