`bot.mjs` is written at `work/knock-g1-2/bot.mjs`. It exports `checkSms(message, now)`, has no dependencies, and sends nothing. I did not commit it.

I checked it with a scratch test script outside the project (`/tmp/sms-check/check.mjs`). All assertions pass under server time zones UTC, Asia/Kolkata, America/New_York, and Pacific/Kiritimati. The sandbox runs Node 24; the code only uses APIs that exist in Node 22.

**How it decides**, checked in this order. The first rule that fails sets `reason`:

1. **Bad input** blocks: `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` (must be a US E.164 number), `invalid_now`, `invalid_opt_out_timestamp`.
2. **Opt-out**: any `optedOutAt` value blocks with `opted_out`. This covers both kinds. Revocation under 47 CFR 64.1200(a)(10) is the basis.
3. **Transactional** texts pass after that. The customer's app action is the consent, and the TCPA's time window does not apply to them.
4. **Marketing only:**
   - `no_marketing_consent` unless `marketingConsent === true` (47 CFR 64.1200(a)(2)).
   - `invalid_time_zone` for a bad IANA zone.
   - `outside_quiet_hours` unless the customer's local time is 08:00–20:59 (64.1200(c)(1)). The time comes from `now` and the customer's zone only, so the server clock is irrelevant.
   - `missing_opt_out_instructions` unless the body contains the whole word STOP, any case (CTIA "Reply STOP to opt out").

**Decisions you should check:**
- **9:00 p.m. boundary.** The rule says "after 9 p.m.", so 21:00:00 is technically allowed. I blocked it as the conservative reading.
- **STOP blocks transactional texts too.** This follows the revoke-all reading of the revocation rule. Login codes after STOP will be blocked. If your lawyers read it differently, change the opt-out step.
- **Immediate opt-out.** The code blocks at once. It does not wait for the 10-business-day window in the rules.

**What the function does not check.** The lawyers need to know these are outside its scope:
- It does not check the National Do Not Call Registry or your internal suppression lists.
- It does not verify that `marketingConsent` means written consent with the required disclosures. It trusts the flag.
- It does not verify that a transactional text was really triggered by the customer. It trusts the caller.
- It does not check sender identification or HELP text in the body.
- It does not check the text content for marketing in transactional messages.

**Legal caveat.** My knowledge has a cutoff. Today is 2026-10-22. Before you give the lawyers this mapping, someone needs to check the current text of 47 CFR 64.1200 and the current CTIA guidelines, especially the revoke-all rule and whether it is still in force. I did not verify either against live sources.
