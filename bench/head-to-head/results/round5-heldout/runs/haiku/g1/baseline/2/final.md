Wrote `bot.mjs` with `checkSms(message, now)` and a test file, `bot.test.mjs`. All 11 tests pass on Node 24.0.0 (the sandbox's version). I did not run it on Node 22, but it only uses long-standing APIs (`Intl.DateTimeFormat`, `formatToParts`). Nothing was sent.

**Rules, in check order** (each blocked case returns its own code):

1. **Bad input fails closed:** `invalid_now`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` (must be a US E.164 number), `invalid_time_zone`, `invalid_opt_out_timestamp`.
2. **`opted_out`:** `optedOutAt` is set. Blocks both kinds. Basis: 47 CFR 64.1200(a)(10) (revocation of consent) and CTIA (STOP ends the program).
3. **Marketing only:**
   - `no_marketing_consent`: `marketingConsent !== true`. Basis: 64.1200(c)(2) and (a)(2).
   - `missing_opt_out_language`: body has no STOP. Basis: CTIA opt-out requirement.
   - `quiet_hours`: local time before 08:00 or at/after 21:00. Basis: 64.1200(c)(1).
4. **Transactional:** no consent or quiet-hours check. Allowed if nothing above blocked it.

Local time comes only from `to.timeZone` through `Intl`. The server zone is never read, and a test checks that the result stays the same under three different `TZ` settings.

**Choices for the lawyers to confirm:**
- After STOP, the function blocks transactional texts too, such as login codes. This is the conservative reading. The alternative is to let transactional texts through, which may not be allowed.
- The quiet-hours check uses the customer's home zone from the profile. The rule speaks of the called party's location, so a customer who is travelling is not covered.
- Written consent is a boolean the caller supplies. The function trusts it. It cannot verify the consent form.
- Transactional is a label the caller supplies. A mislabelled marketing text skips the consent, opt-out-wording and quiet-hours checks. The function does not detect this.
- The STOP check looks only for the word "STOP". CTIA also lists END, CANCEL, UNSUBSCRIBE, QUIT and STOPALL as opt-out keywords. Those are handled upstream, when inbound replies are processed.
- The rule citations are from my memory of 47 CFR 64.1200 and the CTIA principles, not from a fresh check of the current text. The revocation rule (a)(10) was updated recently, so the lawyers should check the exact wording and effective dates.
- There are no frequency caps. They were not in the rules you listed.

Files are in the working directory: `bot.mjs` and `bot.test.mjs`. Run the tests with `node --test bot.test.mjs`. I did not commit anything.
