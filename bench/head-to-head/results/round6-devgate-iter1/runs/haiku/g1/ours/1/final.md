Wrote `bot.mjs` at `work/ours-g1-1/bot.mjs`. It exports `checkSms(message, now)`, has no dependencies, and sends nothing. All assertions passed with the server clock set to UTC, Asia/Tokyo and America/Los_Angeles.

**Checks, in order** (each returns a distinct code):

| Code | Rule it applies |
|---|---|
| `invalid_now` | `now` is not a valid Date |
| `invalid_kind` | kind is not `marketing` or `transactional` |
| `invalid_phone` | phone is not a US E.164 number (`+1` followed by area code and exchange starting 2–9) |
| `opted_out` | marketing only: `optedOutAt` is set (any non-null value) |
| `no_marketing_consent` | marketing only: `marketingConsent` is not `true` |
| `invalid_time_zone` | marketing only: missing or unknown IANA zone, never guessed |
| `outside_marketing_hours` | marketing only: local time is before 08:00 or at/after 21:00 |

The local time comes from `Intl` with the customer's zone passed explicitly, so the server's zone never matters. The 08:00 start is included and the 21:00 end is excluded. The DST change was tested (Nov 2, 2026, after DST ends).

**Choices I made that your lawyers should check:**
- **Transactional texts** skip consent, STOP and hours checks. I read them as customer-triggered messages, outside the marketing rules. A login code still goes out after a STOP. If your counsel reads CTIA's program-level STOP as covering all messages on that number, change the transactional branch to block on `opted_out`.
- **Quiet hours** (08:00–21:00 local) apply only to marketing. This follows 47 CFR 64.1200(c)(1), which restricts telephone solicitations. Texts are covered by FCC guidance on the same rule.
- **Consent** trusts the `marketingConsent` flag. The function cannot check that the sign-up box met the prior-express-written-consent disclosure requirements or that consent was not a condition of purchase. Those facts sit outside the data it receives.
- **Body checks** are not enforced. Both the CTIA recommendation to include sender identification and the "Reply STOP" wording in the body are recommendations, not requirements of 64.1200 for texts, so the function allows the message and does not look at `body`. Add a body check only if counsel says a named rule requires it.

**Not covered** (not in the data you gave me, so I did not add them):
- Do-not-call registry and internal suppression lists
- Frequency caps
- Inbound STOP/START handling. The function reads `optedOutAt` only; whatever receives the STOP reply must write it, and START must clear it.
- Retry times. The return shape is fixed as `{ allowed, reason }`, so refusals give a code, not a sentence or a retry time. Support will need a mapping from code to explanation.

No state is kept, so there is no claim or redelivery logic. The caller must claim each message id before sending, if redelivery is possible.
