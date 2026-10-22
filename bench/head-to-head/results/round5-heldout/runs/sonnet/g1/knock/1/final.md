`bot.mjs` exports `checkSms(message, now)`, and its 27 tests in `bot.test.mjs` pass. They pass with the server time zone set to UTC, Los Angeles and Tokyo. Nothing is sent. Run them with `node --test bot.test.mjs`.

**How each rule maps to a reason code**

The legal reference for each rule is in the header comment of `bot.mjs`, so your lawyers can check it against the code.

| Code | Applies to | Rule |
|---|---|---|
| `invalid_now`, `invalid_message`, `invalid_kind` | both | Malformed input is blocked rather than sent. |
| `non_us_number`, `invalid_phone_number` | both | Only valid +1 numbers go out. A US number's area code and exchange can't start with 0 or 1. |
| `empty_body` | both | Blank text. |
| `opted_out` | marketing | 47 CFR 64.1200(a)(10): consent can be revoked by any reasonable means, including STOP. Any non-null `optedOutAt` blocks, immediately. |
| `invalid_opted_out_at` | marketing | `optedOutAt` is set but isn't a parseable date. Blocked rather than guessed at. |
| `no_marketing_consent` | marketing | 64.1200(a)(2): AI-initiated marketing texts need prior express written consent. `marketingConsent` must be exactly `true`. |
| `invalid_time_zone` | marketing | Local time can't be worked out, so the hours rule can't be checked. |
| `outside_calling_hours` | marketing | 64.1200(c)(1): no solicitation before 8 a.m. or after 9 p.m. at the customer's location. The window is 08:00:00 up to but not including 21:00:00 in the customer's own `timeZone`, including daylight saving. |
| `missing_opt_out_instructions` | marketing | CTIA principles: the body must include the word STOP, for example "Reply STOP to opt out". |

Transactional texts skip the consent, opt-out and hours checks, because the customer triggered them.

**Decisions to confirm with your lawyers**
- **STOP and transactional texts:** a customer who replied STOP still gets login codes and delivery updates they request. If your counsel reads the FCC's revocation rules as covering those too, remove the early return for transactional texts.
- **Mixed content:** a text that contains a promotion must be sent as `marketing`. The function can't detect promotional content in a transactional body.
- **Exactly 9:00 p.m.:** I block it, which is the conservative reading of "after 9 p.m."

**Not covered, because the function isn't given the data**
- National and state Do-Not-Call registry checks.
- State rules with stricter hours, such as Florida and Oklahoma, which stop at 8 p.m.
- The customer's actual location when they are away from home.
- Whether consent was made a condition of purchase.
- Sender identification in the body.
- Carrier frequency and content limits.

I used the `timeZone` from the profile as the called party's location, as you described.
