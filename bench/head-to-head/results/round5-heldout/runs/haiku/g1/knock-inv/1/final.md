Wrote `bot.mjs` in the work directory. All 21 cases pass, including quiet-hours boundaries, server-timezone independence, and the transactional cases. Nothing was sent.

**Behaviour**

Rules are checked in this order. The first failing rule gives the `reason`:

| reason | When |
|---|---|
| `invalid_kind` | kind is not marketing or transactional |
| `invalid_phone_number` | not a US number in +1 E.164 form |
| `empty_body` | body missing or blank |
| `invalid_opt_out_timestamp` | `optedOutAt` set but not a valid date |
| `opted_out` | `optedOutAt` set (either kind) |
| `no_marketing_consent` | marketing and `marketingConsent` is not `true` |
| `invalid_time_zone` | marketing and `timeZone` is not a valid IANA zone |
| `outside_quiet_hours` | marketing and customer's local hour is before 8 or at/after 21 |
| `missing_opt_out_instructions` | marketing body does not contain STOP |
| `transactional_contains_marketing` | transactional body has promo wording (sale, coupon, % off…) |

Quiet hours use the customer's home zone via `Intl`, so the server's zone does not matter.

**Legal mapping for your lawyers**

- Marketing consent: 47 CFR 64.1200(a)(2). The function only checks the `marketingConsent` flag. It cannot check that the sign-up disclosure meets the "prior express written consent" definition in 64.1200(f)(9).
- Quiet hours: 64.1200(c)(1), 8 a.m. to 9 p.m. in the called party's local time.
- Revocation: 64.1200(a)(10). Any `optedOutAt` blocks sends.
- Opt-out wording: CTIA Messaging Principles.
- Transactional: no time window, but the function cannot verify that the customer triggered the text.

I wrote these citations from memory. I did not check them against the current CFR text. The FCC revised the revocation rules in 2024, and some parts had delayed effective dates, so counsel should confirm the current text before relying on this.

**Decisions you should review**

- **STOP blocks transactional texts too.** This is the conservative reading of revocation. Login codes will stop for anyone who replied STOP. If counsel says transactional texts may continue, delete the `opted_out` check from the transactional path. That is one `if` block.
- **Promo-word check on transactional texts** is a keyword heuristic. It catches an AI agent labelling a marketing text as transactional. It will also flag some legitimate messages that contain "deal" or "sale".
- **Not checked:** federal holidays (not required by the TCPA itself, but some states restrict them), frequency caps, and proof that a transactional text was triggered by the customer.

**The skill was thin on this.** `knock-notification-best-practices` says "honor opt-out immediately" and "don't use auto-dialer for marketing". It has no quiet-hours window and no revocation rules, so I used the CFR and CTIA directly.

**Testing:** `/tmp/sms-gate-test/test.mjs` runs the cases and is outside the work directory. I ran it on Node 24.13, not Node 22. The code uses only standard `Intl` and ES module features, so it should run on Node 22, but I have not confirmed that. I did not commit anything.
