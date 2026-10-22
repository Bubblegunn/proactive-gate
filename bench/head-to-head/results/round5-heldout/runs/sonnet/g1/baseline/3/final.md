I wrote `bot.mjs`, which exports `checkSms(message, now)`, and `bot.test.mjs`. All 6 tests pass. I ran them with the server time zone set to Tokyo, and the results were the same, so the server's zone doesn't matter. Nothing is sent.

**Rules, in the order they run**

| Kind | Reason code | Rule |
|---|---|---|
| both | `invalid_message`, `invalid_kind`, `invalid_now`, `invalid_phone`, `empty_body` | The function blocks bad input rather than guessing. The phone must be a US number in `+1` format. |
| marketing | `opted_out` | Once the customer has replied STOP, marketing is blocked immediately. 47 CFR 64.1200(a)(10) requires honoring a revoked consent; the FCC allows up to 10 business days, and this blocks sooner. If `optedOutAt` can't be parsed, the code is `invalid_opt_out_date`. |
| marketing | `no_marketing_consent` | An AI agent sending marketing texts needs prior express written consent (64.1200(a)(2)). Only `marketingConsent === true` counts. |
| marketing | `quiet_hours` | Marketing may not go out before 8 a.m. or after 9 p.m. at the customer's location (64.1200(c)(1)). This uses the profile `timeZone`, including daylight saving. The allowed window is 08:00:00 to 20:59:59 local time. An invalid zone gives `invalid_time_zone`. |
| transactional | none | Customer-triggered texts skip the marketing rules (consent, quiet hours, STOP). |

**Judgment calls to check with your lawyers**
- A STOP reply blocks marketing only. Login codes and delivery updates still go out after STOP, because the customer asked for them. If your lawyers want a STOP to block everything, that is a one-line change.
- If the customer opted out and also has consent ticked, the opt-out wins. The input has no consent date, so there is no way to tell a later re-opt-in.
- A `transactional` message with promotional content is legally marketing. The function can't tell, so whoever sets `kind` has to set it honestly.

**What the function doesn't cover** (the input has no data for it; the file header lists these too)
- National and state Do-Not-Call lists.
- Stricter state calling hours, such as Florida, Oklahoma, and Texas on Sundays.
- CTIA content rules: sender name, STOP/HELP wording, and rates disclosure. I didn't require "Reply STOP" in every marketing body, because CTIA asks for it in the first message and periodically, and the function has no message history.
