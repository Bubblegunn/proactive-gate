`bot.mjs` is written and exports `checkSms(message, now)`. The 27 tests in `bot.test.mjs` pass. I ran them on Node v24.13.0, not Node 22. The code uses no Node 24 features, but I haven't run it on 22. Nothing is sent.

Rules run in this order, and the first one that fails sets the reason code:

| Reason code | Applies to | What stops the text | Source |
|---|---|---|---|
| `invalid_kind` | both | `kind` is not marketing or transactional | fail closed |
| `invalid_phone` | both | not a US `+1` number in E.164 format | fail closed |
| `empty_body` | both | body is empty or only whitespace | fail closed |
| `no_marketing_consent` | marketing | `marketingConsent` is anything other than `true` | 47 CFR 64.1200(a)(2), prior express written consent |
| `opted_out` | marketing | STOP time is now or earlier, or `optedOutAt` can't be parsed | 64.1200(a)(10), revocation of consent; CTIA |
| `invalid_time_zone` | marketing | local time can't be worked out | fail closed |
| `quiet_hours` | marketing | local time is before 08:00 or from 21:00 on | 64.1200(c)(1) |
| `missing_opt_out_notice` | marketing | body doesn't contain "STOP" | CTIA opt-out instruction |

Local time comes from `Intl` with the customer's `timeZone`, so the server's own zone doesn't matter. A test runs the same check under three different `TZ` settings and gets the same result.

Transactional texts skip the consent, STOP, quiet-hours and opt-out-wording checks. Customer-triggered texts aren't telephone solicitations.

These are my assumptions, which your lawyers should confirm:
- **STOP and transactional texts:** a STOP reply blocks marketing only. Login codes and delivery updates the customer asks for still go out. The FCC's broader rule that one revocation covers every text from you is currently delayed, so I didn't implement it.
- **Quiet hours:** they use the home time zone as the customer's location. A customer who is travelling may be somewhere else. Some states are stricter than the federal 8:00–21:00 window (for example Florida, Oklahoma, Maryland and Washington use 8:00–20:00), and I did not implement those.
- **Opt-out wording:** I read "tell the customer how to opt out" as the body containing the word STOP. I didn't check for sender name, "msg & data rates" wording or message length.
- **Invalid `now`:** an invalid `Date` for `now` throws a `TypeError` instead of returning a result.
