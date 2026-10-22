Wrote `bot.mjs` at `work/ours-g1-3/bot.mjs`. It exports `checkSms(message, now)`, has no dependencies, and sends nothing. I ran a self-check under four server zones (UTC, Asia/Tokyo, Pacific/Honolulu, America/Chicago). All checks passed in each, including the 8:00 and 21:00 boundaries and the spring-forward date.

**Reason codes**

| Code | Blocks when |
|---|---|
| `invalid_now` | `now` is not a valid Date |
| `invalid_message` | `kind` is not marketing or transactional, or `body` is not a string |
| `invalid_recipient` | `to` is missing or `phone` is not a US E.164 number (+1, NANP format) |
| `opt_out_status_unknown` | `optedOutAt` is missing (undefined) |
| `invalid_opt_out_timestamp` | `optedOutAt` is neither null nor a valid ISO 8601 string |
| `opted_out` | `optedOutAt` is a valid timestamp (either kind) |
| `no_marketing_consent` | Marketing text and `marketingConsent` is not exactly `true` |
| `invalid_time_zone` | Marketing text and `timeZone` is not a valid IANA zone |
| `outside_marketing_hours` | Marketing text and the customer's local time is before 08:00 or at/after 21:00 |

When allowed, `reason` is `null`.

**How it maps to the rules**

- **Marketing consent (47 CFR 64.1200(a)(2)):** marketing texts need `marketingConsent === true`. The function trusts that flag. Whether the sign-up wording and records meet the written-consent standard is for your lawyers to confirm; the function does not check it.
- **Time of day (47 CFR 64.1200(c)(1)):** marketing texts are allowed only from 08:00 (inclusive) to 21:00 (exclusive) in the customer's `timeZone`. Local time comes from `Intl` with that zone, so the server's zone has no effect.
- **Opt-out (47 CFR 64.1200(a)(10); CTIA):** any valid `optedOutAt` blocks both kinds. CTIA says that after STOP, a program sends no further messages except a one-time confirmation.
- **Transactional texts:** they skip the consent and time-of-day checks, since the customer triggered them.

**Decisions to confirm with your lawyers**

- **Login codes after STOP are blocked.** I chose this because the single `optedOutAt` field can't tell whether STOP covered only marketing. If your lawyers say STOP covers marketing only, remove the `opted_out` check for transactional messages.
- **Transactional texts have no time-of-day window.** A login code must arrive when the customer asks for it, even late at night.
- **The body is not checked.** I did not add a check for required opt-out notices or message length. Nothing in your brief requires one, so add one only if your lawyers say it applies.

Not in the function: rate caps, retry or dedupe on send, and any state. The caller must handle those if you need them.
