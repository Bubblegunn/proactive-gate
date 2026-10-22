Wrote `bot.mjs` in the work directory. It exports `checkSms(message, now)`, has no dependencies, and sends nothing. All 18 self-checks pass, and the result does not change with the server's time zone (checked under UTC, Pacific/Kiritimati, and America/Los_Angeles).

**Checks, in order. The first failing check sets `reason`:**

| reason | when |
|---|---|
| `invalid_message` | message is not an object |
| `invalid_kind` | kind is not `marketing` or `transactional` |
| `invalid_recipient` | `to` missing, or `optedOutAt` absent (not null) |
| `invalid_phone_number` | not `+1` followed by a valid NANP 10-digit number |
| `empty_body` | body is missing or only whitespace |
| `opted_out` | `optedOutAt` is any non-null value |
| `no_marketing_consent` | marketing, and `marketingConsent !== true` |
| `invalid_time` | marketing, and `now` is not a valid Date |
| `invalid_time_zone` | marketing, and `timeZone` is not a valid IANA zone |
| `quiet_hours` | marketing, and local time is outside 08:00 to 21:00 |

Transactional texts pass once the checks above them succeed. They have no time window and no consent check. Local time comes from `Intl` with the customer's zone, so DST is handled by the wall clock.

**Decisions you should confirm with counsel:**
- **Transactional texts are blocked after STOP.** I read revocation as applying to all texts from you to that phone. Login codes will stop working for a customer who has replied STOP. If counsel decides otherwise, the change is one line in the `opted_out` check.
- **The marketing window is 08:00 (included) to 21:00 (excluded) in the customer's home zone.** This follows the FCC telemarketing calling window. I did not fetch the CFR text in this session, so the citations in the file's comments come from my memory of 47 CFR 64.1200 and are not verified against the current text. Please have counsel check them.
- **A missing `optedOutAt` is treated as bad data (`invalid_recipient`), not as opted out.** An explicit `null` is the "not opted out" value.

**Not covered by the function (listed in the file's comments):**
- Do-Not-Call registry checks (no DNC data is passed in).
- The 10-business-day processing window for revocations.
- Whether the sign-up form meets the written-consent wording.
- Sender ID and HELP/STOP text in the message body.

These are process or data items the function cannot see. You will need them for the legal answer.

I did not add a persistent test file. The self-checks ran inline. The machine runs Node v24; the code uses only standard features and should run on Node 22.
