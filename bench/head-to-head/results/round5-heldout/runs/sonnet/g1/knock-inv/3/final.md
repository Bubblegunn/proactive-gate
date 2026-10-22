I wrote `bot.mjs` with `checkSms(message, now)` and a test file, `bot.test.mjs`. All 15 tests pass under `node --test`. Nothing is sent.

**Reason codes**, checked in this order:

| Applies to | Code | Blocks when |
|---|---|---|
| both | `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_phone` | the input is malformed, or the phone is not a US E.164 number |
| marketing | `opted_out` | `optedOutAt` is anything other than null |
| marketing | `no_marketing_consent` | `marketingConsent` is not exactly `true` |
| marketing | `missing_opt_out_instructions` | the body has no word "STOP" |
| marketing | `invalid_time_zone` | the time zone is missing or not a valid IANA zone |
| marketing | `quiet_hours` | the local time is 21:00:00 to 07:59:59 |

**How it follows the rules**, which the lawyers can check against the comments at the top of the file:
- **Consent (47 CFR 64.1200(a)(2)):** AI-sent marketing texts need prior express written consent. The function requires the sign-up box to be ticked.
- **STOP (64.1200(a)(10) and CTIA):** marketing stops as soon as `optedOutAt` is set. The FCC allows up to 10 business days, so this is stricter than the rule. An unparseable or future timestamp also blocks.
- **Calling hours (64.1200(c)(1)):** no marketing before 8 a.m. or after 9 p.m. at the customer's location. The function uses the profile `timeZone` through `Intl`, so the server's own time zone does not matter, and the tests cover DST. It blocks from exactly 21:00, which is slightly stricter than "after 9 p.m."
- **CTIA opt-out wording:** marketing texts must contain "STOP" instructions.
- **Transactional texts:** customer-triggered login codes and delivery updates are not solicitations. They skip the calling-hours window, the consent box and the marketing STOP. They still need a valid phone and a non-empty body.

**Decisions to confirm with counsel:**
- **Transactional after STOP:** I treated STOP as ending marketing only. The FCC's newer revoke-all rule could be read to cover every text, and that part has been delayed, so check its status. If your lawyers want the stricter reading, add one early check for transactional texts.
- **Time zone as location:** the profile time zone stands in for where the customer actually is. The rule refers to their real location.
- **Promo content in transactional texts:** the function cannot detect it. A transactional text with promotional content is a marketing text under the rules.
- **Checks outside this function:** it does not verify that a text was really customer-triggered. It also does not check the National Do Not Call list or carrier registration, and it keeps no consent records.
