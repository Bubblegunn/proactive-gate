`bot.mjs` is written and exports `checkSms(message, now)`. I checked it with a test script covering about 20 cases: quiet-hours edges, daylight-saving time, Hawaii and each block code. It passed with the server time zone set to UTC, Asia/Tokyo and America/Los_Angeles. Nothing is sent. The test script is `/tmp/bot-test.mjs`, outside the repo.

I read the Courier skill's SMS reference and used it for the CTIA STOP handling and the 10DLC categories. I did not look up the CFR text itself, so the rule mapping below is from my own knowledge. Have your lawyers confirm it.

**Checks, in order.** The first failing rule sets `reason`.

| Code | Applies to | Blocks when |
|---|---|---|
| `invalid_message`, `invalid_kind`, `invalid_now`, `empty_body` | both | the input is malformed |
| `invalid_phone_number` | both | the number is not a US `+1` number with 10 digits |
| `invalid_opted_out_at` | both | `optedOutAt` is not null and is not a parseable timestamp (blocks to be safe) |
| `opted_out` | both | `optedOutAt` is non-null |
| `no_marketing_consent` | marketing | `marketingConsent` is not exactly `true` |
| `missing_opt_out_notice` | marketing | the body has no "STOP" instruction |
| `invalid_time_zone` | marketing | `timeZone` is not a valid IANA zone (blocks to be safe) |
| `quiet_hours` | marketing | the recipient's local time is before 08:00 or at 21:00 or later |
| `promotional_content` | transactional | the body contains promotional wording |

**How it follows the rules**
- **Consent:** marketing texts need prior express written consent under 47 CFR 64.1200(a)(2), which `marketingConsent` stands in for.
- **Calling hours:** 64.1200(c)(1) bars solicitations before 8 a.m. or after 9 p.m. at the called party's location. The gate uses `to.timeZone` through `Intl`, so the server's own zone never matters.
- **Transactional texts:** they have no time limit and need no marketing consent because the customer triggered them. A text with a promotion mixed in counts as marketing, so it is blocked as `promotional_content`.
- **STOP:** the gate blocks both kinds after STOP, since CTIA treats STOP as ending the program and your provider would block the number anyway. If you want to allow a one-time reply to a customer's own request, that is a small change.
- **Opt-out notice:** CTIA expects opt-out instructions in marketing messages. I require "STOP" in every marketing text, which is stricter than the minimum.

**Limits to tell your lawyers about**
- The promotion check is a keyword heuristic, not a legal judgment.
- The caller must only label a text `transactional` when the customer's action caused it. The function cannot verify that.
- **Not covered:**
  - Stricter state rules, such as Florida and Oklahoma ending at 8 p.m. and weekend or holiday limits in some states.
  - Do-Not-Call list checks.
  - Frequency caps.
  - Brand-name text.
  - 10DLC registration.
- It assumes your backend clears `optedOutAt` when a customer replies START.
