`bot.mjs` is written, and my check script passes. I ran it under three server time zones (UTC, Asia/Tokyo, America/Los_Angeles) with the same results. Nothing is sent.

The check script is `/tmp/bot-check/check.mjs`, outside the repo. It covers the 8:00 and 21:00 edges, both daylight-saving changes in Chicago, other zones, and each reason code.

## Rules, in the order checked

The first rule that fails sets the reason.

| Reason code | Applies to | Rule |
|---|---|---|
| `invalid_now` | both | `now` is not a valid Date |
| `invalid_message` | both | message, kind, body or recipient is missing or malformed |
| `invalid_phone` | both | phone is not `+1` plus a valid US number (area code and exchange start 2–9) |
| `empty_body` | both | body is blank |
| `opted_out` | marketing | `optedOutAt` is set. 47 CFR 64.1200(a)(10) requires honoring a revocation, and CTIA requires STOP to end messages. |
| `no_marketing_consent` | marketing | `marketingConsent` is not exactly `true`. This is the prior express written consent in 64.1200(a)(2). |
| `invalid_time_zone` | marketing | the time zone is missing or not a real IANA zone |
| `quiet_hours` | marketing | the customer's local time is before 8:00 or at 21:00 or later. This is 64.1200(c)(1). |
| `missing_opt_out_instructions` | marketing | the body does not contain the word STOP. This is the CTIA opt-out requirement. |

The local hour comes from `Intl.DateTimeFormat` with the customer's zone, so the server's own zone has no effect.

## Choices your lawyers should confirm

- **Opt-out takes effect immediately.** The FCC allows up to 10 business days, and CTIA expects it at once, so I block at once. A bad `optedOutAt` value also counts as opted out.
- **Transactional texts are allowed after STOP.** They skip the consent, opt-out and quiet-hours checks, because the customer triggered them. The FCC's "revoke-all" provision may cover them. I'm not certain of its current effective date. If counsel wants them blocked, add an `opted_out` check before the transactional return.
- **21:00:00 exactly is blocked.** The rule says "after 9 p.m.", so this is stricter than required.
- **A blank or invalid zone fails closed for marketing.**

## Not covered

- National Do-Not-Call registry and internal do-not-call lists, because the function has no data for them.
- Stricter state rules, such as Florida's 8:00–20:00 window and Maryland's. The function uses the federal 8:00–21:00 window.
- Detecting marketing content inside a message labeled transactional. A mixed message is legally telemarketing, and a label can't catch it.
- Sender identification in the body and the HELP keyword. The function only checks for STOP.
- The customer's actual location. The function uses the home time zone from the profile, as you specified.
