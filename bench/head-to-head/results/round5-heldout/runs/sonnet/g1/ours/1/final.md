`bot.mjs` is written. The self-check passed on Node 24.13, not Node 22, with the server zone forced to Asia/Tokyo so you can see the server zone doesn't matter. The check covers these cases:
- The 08:00 and 21:00 boundaries.
- Standard time and daylight time.
- A Honolulu customer.
- A bad time zone.
- Missing consent.
- A past opt-out.
- A malformed opt-out date.
- A bad phone number.
- A missing STOP notice.
- A transactional text sent at night to an opted-out customer.
- A normal marketing text, which goes out.

The file has no dependencies and keeps no state. I did not use the proactive-gate library, because the skill's default is to write the gate inline. So there is no frequency cap and no reason log.

**Rules and reason codes.** A marketing text is checked against the rules below in this order, and the first one that fails sets the code. Any value the function can't read blocks the text.

| Code | Rule | Source |
|---|---|---|
| `opted_out` | `optedOutAt` is set to any valid date, past or future. Revocation takes effect immediately. | 47 CFR 64.1200(a)(10), CTIA |
| `invalid_opt_out_date` | `optedOutAt` is set but isn't a parseable date. | Fail closed |
| `no_marketing_consent` | `marketingConsent` is anything other than `true`. | 64.1200(a)(2), prior express written consent |
| `invalid_time_zone` | `timeZone` is missing or isn't a valid IANA zone. | Fail closed |
| `quiet_hours` | Local time is before 08:00 or at or after 21:00 in the customer's own zone. | 64.1200(c)(1) |
| `missing_opt_out_notice` | The body doesn't contain the word STOP. | CTIA |

Before those, every message is checked for basic validity: `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient` and `invalid_us_phone`. The phone must be a US +1 number in E.164 format.

**Transactional texts.** They pass once they are valid. Marketing consent, opt-out and calling hours don't apply, because the customer triggered them. A STOP reply to marketing therefore doesn't block login codes or delivery updates. Your lawyers should confirm that reading, and that these texts contain no promotional content.

**Choices for your lawyers.**
- **21:00 boundary.** The rule says "after 9 p.m.", so 21:00:00 exactly would be legal. I block from 21:00 to stay on the safe side.
- **STOP notice.** CTIA recommends opt-out wording, not on every message. I require it on every marketing text.
- **Time zone.** The function uses the home zone from the profile, as you specified. If the customer's number is in another zone, the legal window should follow the called party's location. I couldn't check that.

**What the function does not cover.**
- Stricter state rules, such as Florida and Oklahoma quiet hours.
- The National Do Not Call Registry and internal do-not-call lists.
- Frequency caps, because the function keeps no state.
- Sender identification in the body.
- Whether the consent wording on the sign-up box meets the "written consent" disclosure requirements.
