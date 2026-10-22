I wrote `bot.mjs` in the work directory. `checkSms(message, now)` returns `{ allowed, reason }` and sends nothing. All 24 test cases pass under four different server time zones, and `node --check` passes. I ran the tests on Node 24 because that is the local version; the code uses nothing newer than Node 22 supports. I have not committed anything.

**Check order (first failing rule wins):**

| Order | Condition | `reason` |
|---|---|---|
| 1 | Malformed input (message, `now`, `kind`, recipient, phone not US E.164 with a valid area code, empty body, bad `optedOutAt`, bad or missing `timeZone`) | `invalid_message`, `invalid_time`, `invalid_kind`, `invalid_recipient`, `invalid_phone`, `empty_body`, `invalid_opt_out_timestamp`, `invalid_time_zone` |
| 2 | `optedOutAt` is set (applies to both kinds) | `opted_out` |
| 3 | Transactional | allowed |
| 4 | Marketing, `marketingConsent !== true` | `no_marketing_consent` |
| 5 | Marketing, body has no `STOP` word | `marketing_missing_opt_out_instructions` |
| 6 | Marketing, local hour outside 08:00–20:59 in `to.timeZone` | `marketing_quiet_hours` |

**How it maps to the rules:**
- **47 CFR 64.1200(a)(2), prior express written consent:** marketing needs `marketingConsent: true`. The function trusts that flag. Your lawyers need to confirm the stored record meets their written-consent standard.
- **47 CFR 64.1200(a)(10), revocation:** any recorded STOP blocks every text from this sender, including transactional. This is the conservative reading. Carrier and provider practice is similar.
- **47 CFR 64.1200(c)(1), quiet hours:** 08:00–21:00 at the customer's home zone, applied to marketing only. Local time comes from `Intl` with the explicit zone, so the server zone never matters.
- **CTIA Messaging Principles:** marketing must tell the customer how to opt out. I enforce this with a `STOP` word check. That is a rough proxy, not a full check of CTIA's disclosure requirements.
- **Transactional texts:** allowed without marketing consent because the customer triggered them.

**Decisions for you and the lawyers:**
- **Transactional after STOP is blocked.** A customer who texted STOP will not get login codes or delivery updates from this sender. Confirm you want that trade-off.
- **The revoke-all rule's current status is unverified.** I cannot check the FCC's implementation dates or litigation status as of October 2026. Have counsel confirm whether revoke-all applies as written.
- **Not covered:** sender identification in the body, 10DLC or carrier registration, frequency caps, and time zones for non-US numbers (the function rejects them).

Test cases are in `/tmp/bot-check/check.mjs`, outside the repo.
