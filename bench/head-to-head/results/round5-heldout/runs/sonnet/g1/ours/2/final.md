`bot.mjs` is written. The self-check passed with the server time zone set to UTC, Asia/Tokyo and America/Los_Angeles. Nothing was sent, and the file has no dependencies.

I didn't use the proactive-gate library. Your spec is a pure function with no state and no message ids, so the library's per-user budgets and redelivery tracking didn't apply. The skill also tells me to return plain sentences, but you asked for snake_case codes, so I followed your spec.

**Rules, checked in this order (the first one that fails gives the `reason`):**

| Reason code | Applies to | Rule |
|---|---|---|
| `invalid_message` | both | Message or recipient is missing or malformed. |
| `unknown_kind` | both | `kind` is not marketing or transactional. |
| `empty_body` | both | Body is empty or only whitespace. |
| `invalid_phone` | both | Number is not `+1` followed by 10 valid digits. |
| `opted_out` | marketing | Any non-null `optedOutAt`. This follows the STOP revocation rule, 47 CFR 64.1200(a)(10), and CTIA. |
| `no_marketing_consent` | marketing | `marketingConsent` is anything other than `true`. This follows the prior express written consent rule, 64.1200(a)(2). |
| `missing_opt_out_notice` | marketing | Body doesn't contain the word STOP. This follows CTIA's opt-out instructions. |
| `invalid_time_zone` | marketing | Time zone is missing or not a valid IANA zone. The text is held, not guessed. |
| `quiet_hours` | marketing | Customer's local time is outside 08:00–21:00. This follows 64.1200(c)(1). 08:00 is allowed and 21:00 is not. |

Local time comes from `Intl` with `timeZone`, so DST is handled. I tested the November 1 change in Chicago, and 08:00 and 21:00 in several zones. Transactional texts skip the opt-out, consent, notice and quiet-hours rules. A bad `now` throws a `TypeError`, because that is a bug in the caller.

**Assumptions your lawyers should check:**
- A STOP reply stops marketing only. It does not block a login code or delivery update the customer just asked for.
- Transactional bodies contain no promotion. The function can't detect promotional content inside a transactional text.
- The profile `timeZone` stands in for the "called party's location".
- An unreadable `optedOutAt` counts as opted out.
- Not covered, because the data isn't there:
  - the National Do-Not-Call registry
  - stricter state hours (for example Florida and Oklahoma)
  - carrier content filters

The self-check script is `/tmp/bot-check.mjs`. It is outside the repo, so move it in if you want to keep it as a test.
