`bot.mjs` exports `checkSms(message, now)`, and its 27 tests pass. I also ran them with the server clock set to UTC, Tokyo, Auckland and Los Angeles, and the results didn't change. Nothing is sent. The tests are in `bot.test.mjs` (run with `node --test bot.test.mjs`).

The function checks marketing texts in this order and stops at the first rule that fails. The reason codes are the ones support will see.

| Reason code | What stopped the text | Rule it follows |
|---|---|---|
| `invalid_input`, `invalid_kind`, `invalid_phone`, `empty_body` | The message is malformed. Phone numbers must be US `+1` numbers. | Bad input is blocked rather than guessed at. |
| `opted_out` | The customer replied STOP. Any non-null `optedOutAt` counts, even an unparseable one. | 47 CFR 64.1200(a)(10) lets a customer revoke consent. CTIA says STOP ends the program. The FCC allows 10 business days to honor a STOP, but this blocks immediately. |
| `no_marketing_consent` | `marketingConsent` is not exactly `true`. | 64.1200(a)(2) requires prior express written consent for automated marketing texts. |
| `invalid_time_zone` | The customer's time zone is missing or unknown. | The quiet-hours check can't run, so the text is blocked. |
| `quiet_hours` | It is before 8:00 or at/after 21:00 in the customer's home time zone. | 64.1200(c)(1) bars telemarketing before 8 a.m. or after 9 p.m. at the called party's location. |
| `missing_opt_out_instructions` | The body has no "STOP" word. | CTIA requires marketing texts to say how to opt out. |

The local hour is computed from `now` with `Intl` and the customer's `timeZone`, so the server's own time zone plays no part. Daylight saving time is covered by tests in both summer and winter.

Transactional texts skip every marketing rule. They only get the input checks. A login code can go at 3 a.m., without marketing consent, and after a STOP.

Three points for your lawyers:

- **Transactional after STOP:** I allowed it because the customer asked for the code or update. The FCC's newer rule that STOP applies to all automated texts from a sender has narrow exceptions, so please have counsel confirm. The choice is the early `return ALLOW` for transactional in `checkSms`.
- **Marketing mixed into a transactional text:** the FCC treats that as telemarketing, and the function can't detect it. The `kind` you pass in is trusted.
- **Quiet-hours location:** the check uses the home time zone from the profile, as you specified. A customer who is travelling may be in a different zone, and the rule refers to the customer's actual location.

I also didn't add a check that marketing texts name your brand, since that can't be verified reliably from the body text. Consent records, a frequency cap and the 160-character length limit are not part of this function.
