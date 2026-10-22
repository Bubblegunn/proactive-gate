`bot.mjs` is written and exports `checkSms(message, now)`. I tested it with 19 cases, and all passed. I ran them with the server set to UTC, Asia/Tokyo and America/Los_Angeles, and the results were the same each time. The test script is `/tmp/t.mjs`, outside the repo.

**Rules, in the order they are checked (the first one that matches is the reason returned):**

| Applies to | Code | Blocks when | Rule |
|---|---|---|---|
| Both kinds | `invalid_message` | The message is missing, or `kind` is not `marketing` or `transactional`. | Input validation |
| Both kinds | `invalid_phone` | The number is not a US `+1` number with 10 digits. | Input validation |
| Both kinds | `empty_body` | The body is blank. | Input validation |
| Marketing only | `opted_out` | `optedOutAt` is set to anything other than null. | Revoked consent must be honored (47 CFR 64.1200(a)(10)); CTIA STOP handling |
| Marketing only | `no_marketing_consent` | `marketingConsent` is not exactly `true`. | Prior express written consent (64.1200(a)(2), (f)(9)); CTIA opt-in |
| Marketing only | `invalid_time_zone` | `timeZone` is missing or not a valid IANA zone. | Fails closed, because local time can't be computed |
| Marketing only | `quiet_hours` | The customer's local time is before 08:00 or at/after 21:00. | 64.1200(c)(1) |
| Marketing only | `missing_opt_out_notice` | The body has no "STOP" word. | CTIA opt-out instructions |

Local time comes from `Intl` using the customer's profile zone, so the server's time zone and daylight saving don't affect the result. 08:00:00 is allowed and 21:00:00 is blocked.

Transactional texts skip the consent, quiet-hours and STOP checks, because the customer triggered them. A login code at 3am goes out even to someone who replied STOP to marketing. Your lawyers should confirm this reading. The FCC's newer "revoke-all" language could be read to cover them. If they say it does, move the `opted_out` check above the transactional return.

**Limits to tell your lawyers about:**
- The function trusts `kind`. It does not read the body, so a "transactional" text that contains a promotion would go out unchecked.
- It does not check the National or internal Do-Not-Call lists, state laws with stricter hours (Florida and Oklahoma, for example), or carrier campaign registration. It also does not check message frequency or whether the text names the sender. The function has no data for any of these.
- Any non-null `optedOutAt` blocks marketing, even a malformed or future date. It never lifts the block if the customer opts back in. A re-consent flow would have to clear `optedOutAt` upstream.
- The `missing_opt_out_notice` check was my choice, based on CTIA's recommendation. The FCC text rule doesn't require it. If your AI agent should only add it to a customer's first text, relax that check.
- A bad `now` throws a `TypeError`, since that is a bug in the calling code rather than a customer problem.
