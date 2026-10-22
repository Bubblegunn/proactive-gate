`bot.mjs` is written and exports `checkSms(message, now)`. I tested it in `bot.test.mjs`: all 9 tests pass with the server time zone set to UTC and again set to Asia/Tokyo. The tests were run on Node 24.13 here, not Node 22. The code uses only `Intl`, which Node 22 also has. Nothing is sent.

**How it follows the rules.** Checks run in this order, and the first one that fails gives the reason code:

| Code | Rule |
|---|---|
| `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` | The input is malformed. The phone must be a US `+1` number in E.164 format. These apply to both kinds of text. |
| `opted_out` | Marketing only. The customer revoked consent (47 CFR 64.1200(a)(10); CTIA says STOP ends marketing). It blocks from `optedOutAt` onward, with no 10-business-day grace period. A future-dated opt-out does not block yet. |
| `invalid_opt_out_date` | Marketing only. `optedOutAt` can't be parsed, so the text is blocked. |
| `no_marketing_consent` | Marketing only. Marketing texts need prior express written consent (64.1200(a)(2)). Only a strict `true` counts. |
| `invalid_time_zone` | Marketing only. The time zone is not a valid IANA name, so the text is blocked. |
| `quiet_hours` | Marketing only. Marketing may not go out before 8 a.m. or after 9 p.m. at the customer's location (64.1200(c)(1)). It uses the profile time zone, so DST is handled. 08:00:00 to 20:59:59 local is allowed and 21:00:00 is blocked. |
| `missing_opt_out_instructions` | Marketing only. CTIA expects opt-out instructions, so the body must contain the word STOP. |

Transactional texts skip all the marketing-only checks, because the customer asked for them by using the app. A customer who replied STOP to marketing still gets their login codes and delivery updates.

**Judgment calls to confirm with your lawyers:**
- **STOP and transactional texts:** a customer who replies STOP still gets transactional texts. A stricter reading of the FCC's revocation rules could say otherwise.
- **Opt-out wording:** requiring "STOP" in every marketing body is my reading of CTIA, not a hard federal rule. It also blocks AI-written text that forgets the wording, which I think is what you want.
- **Not covered:** stricter state quiet-hours laws (for example Florida and Maryland), carrier content filtering, sender identification, and promotional content inside a transactional text. The FCC treats that last case as marketing, and the function can't detect it.
- **Customer's location:** the profile time zone is only the customer's home. If they travel, "the called party's location" in the rule could differ.
