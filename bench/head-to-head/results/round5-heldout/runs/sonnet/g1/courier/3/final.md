`bot.mjs` is written and exports `checkSms(message, now)`. I ran 27 assertions against it with the server time zone set to UTC, Asia/Tokyo and America/Los_Angeles, and all passed. Nothing is sent. The test script is `/tmp/bot-test.mjs`, outside the repo. I haven't added a test file to the repo.

**Rules, in the order they are checked.** The first rule that fails sets the reason code.

| Code | Applies to | Basis |
|---|---|---|
| `invalid_message`, `invalid_now`, `unknown_kind`, `empty_body`, `invalid_phone` | both kinds | Input checks. The phone must be a US +1 number with 10 digits. |
| `opted_out` | marketing only | Customer replied STOP. 47 CFR 64.1200(a)(10) says consent can be revoked by any reasonable means. CTIA says STOP ends the program. |
| `invalid_opted_out_at` | marketing only | `optedOutAt` can't be parsed, so the text is blocked. |
| `no_marketing_consent` | marketing only | `marketingConsent` is not exactly `true`. 47 CFR 64.1200(a)(2) requires prior express written consent for autodialed marketing texts, and CTIA requires opt-in. |
| `quiet_hours` | marketing only | 47 CFR 64.1200(c)(1) bars solicitation before 8 a.m. or after 9 p.m. at the called party's location. The window is 08:00:00 up to 21:00:00 in `to.timeZone`. |
| `invalid_time_zone` | marketing only | The zone is missing or not a real IANA zone, so the hour can't be checked and the text is blocked. |

**How the function follows the rules.**
- **Marketing:** it must pass every check above.
- **Transactional:** only the input checks apply. These texts are not solicitations, so a login code still goes out at 3 a.m. or after a STOP.
- **Time zone:** the local hour comes from `Intl` with the customer's zone, so DST is handled and the server's zone never matters. The tests cover the exact 08:00 and 21:00 boundaries, a DST-change day, and the same instant in different zones.

**Decisions for you or your lawyers.**
- **Transactional after STOP:** I let transactional texts through after a STOP, on the view that the customer asked for them in the app. The FCC's rule that revoking consent covers all messages from a sender is not something I could confirm, and I did not check its current status. If counsel wants a STOP to block everything, remove the early return for transactional in `checkSms`.
- **Re-consent:** your data has no re-consent timestamp, so any `optedOutAt` blocks marketing permanently. A future `optedOutAt` also blocks.
- **Home zone:** it is a proxy for the customer's actual location, which is what the rule refers to.

**Not covered, because the message carries no data for it.**
- The National Do-Not-Call Registry (64.1200(c)(2)).
- Reassigned-number checks.
- State laws with stricter hours, such as Florida and Oklahoma.
- Carrier content rules.
- The CTIA advice to name the sender and include STOP/HELP wording in the text.

The last two are rules about the message text. Add a body check if you want them enforced.
