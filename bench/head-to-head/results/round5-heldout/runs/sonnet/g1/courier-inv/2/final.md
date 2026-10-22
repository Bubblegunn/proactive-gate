`bot.mjs` exports `checkSms(message, now)`. I ran `bot.test.mjs` under three server time zones (UTC, Tokyo, Los Angeles) and every check passed. Nothing is sent.

**Rules and reason codes**

The first failing rule decides the reason. Marketing texts are checked in this order:

| Reason | Rule | Source |
|---|---|---|
| `marketing_opted_out` | `optedOutAt` is set. | Revocation of consent under 47 CFR 64.1200(a)(10); CTIA treats STOP as ending the program. |
| `marketing_consent_missing` | `marketingConsent` is not exactly `true`. | Written consent, 47 CFR 64.1200(a)(2). |
| `marketing_quiet_hours` | Local time is before 08:00 or at/after 21:00. | 47 CFR 64.1200(c)(1). |
| `invalid_time_zone` | The `timeZone` value is not a valid IANA zone. | Fail-closed: the quiet-hours check can't run. |
| `marketing_missing_opt_out` | The body doesn't contain the word STOP. | CTIA principle that marketing includes opt-out instructions. |

Checks that apply to both kinds, run before the rules above: `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_phone` (must be E.164).

Local time comes from the customer's `timeZone` through `Intl`, so DST is handled and the server's time zone doesn't matter. The tests cover the 08:00 and 21:00 boundaries and a January/July DST case.

**Decisions your lawyers should confirm**
- **Transactional texts:** they skip the consent, quiet-hours and STOP-in-body checks. They are customer-triggered, so I treated them as not telemarketing. A STOP reply blocks marketing only. If counsel wants STOP to block everything, move the `optedOutAt` check above the transactional return.
- **Time zone:** the profile's home zone stands in for the called party's location. A customer who is travelling is judged by their home zone.
- **Opt-out date:** any `optedOutAt` value blocks marketing, including a future or unparsable one. There is no re-subscribe logic, so a customer who texts START has to have `optedOutAt` cleared upstream.
- **Not checked:** brand identification in the body, message frequency, and CTIA's content rules (for example, prohibited content categories). The body can't be checked reliably for these.
- **Provider side:** Twilio also blocks sends to a number after STOP (error 21610) and needs 10DLC registration. This function doesn't replace either.

Files are in <HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round5-heldout-sonnet/work/courier-inv-g1-2:
- bot.mjs
- bot.test.mjs
