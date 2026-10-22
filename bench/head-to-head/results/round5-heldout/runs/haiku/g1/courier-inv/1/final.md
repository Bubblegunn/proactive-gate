I wrote `bot.mjs` with `checkSms(message, now)`, plus a test file. All 19 tests pass under five server time zones (UTC, Los Angeles, Tokyo, Kiritimati, and the default). Nothing was sent. I did not use the Courier SDK, since this function only decides whether a text may go out.

**Checks, in order (first failure wins):**

| Reason code | Rule |
|---|---|
| `invalid_now` / `invalid_message` / `unknown_message_kind` / `invalid_recipient` | Input is malformed. |
| `invalid_phone_number` | Must be a US E.164 number (`+1` and 10 digits, area code and exchange starting 2–9). |
| `empty_body` | Body is blank. |
| `invalid_opt_out_timestamp` / `opted_out` | `optedOutAt` is not `null`. A malformed or missing value fails closed. Blocks both kinds. |
| `marketing_consent_missing` | Marketing needs `marketingConsent === true` (47 CFR 64.1200(a)(2), prior express written consent for marketing texts to wireless numbers). |
| `missing_opt_out_language` | Marketing body must contain "STOP" (CTIA: program messages must say how to opt out). |
| `invalid_time_zone` | `timeZone` missing or not a valid IANA zone. It never falls back to the server zone. |
| `quiet_hours` | Marketing only. Blocked before 08:00 or from 21:00 in the customer's zone (47 CFR 64.1200(c)(1), applied to texts per the FCC's 2012 order). |

Transactional texts pass once the opt-out check clears. They need no consent flag, because the customer supplied the number and triggered the message.

**Decisions for your lawyers:**
- **STOP blocks transactional texts too.** I treated STOP as ending the whole program, per CTIA. That means a customer who texted STOP gets no login codes. The alternative is to let transactional texts through, and that is a legal call.
- **Transactional consent is assumed, not checked.** The input has no field showing the customer triggered the text, so the function cannot verify it.
- **`marketingConsent` is a boolean.** The function cannot show when or how consent was given. A consent record with a timestamp and disclosure text would be needed as evidence.
- **Quiet hours use the profile's home zone.** A customer who travels may be texted at an hour that is quiet where they actually are.
- **Sender identification is not checked.** CTIA expects marketing texts to name the brand. The function has no brand field to check.

**Environment note:** this sandbox runs Node 24.13, not Node 22. The code uses only standard features (`Intl`, `Date`, `node:test`), but I have not run it on Node 22.

Files are in `work/courier-inv-g1-1/`: `bot.mjs` and `bot.test.mjs`. Run the tests with `node --test bot.test.mjs`. I did not commit anything.
