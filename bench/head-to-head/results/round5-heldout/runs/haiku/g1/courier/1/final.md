I wrote `bot.mjs` with `checkSms(message, now)`. It sends nothing. A 13-test suite in `bot.test.mjs` passes on Node 24.13.0 (the sandbox's version; you asked for Node 22, which I did not run). Both files are in `work/courier-g1-1/`.

**Checks, in order** (each blocked case returns its own reason code):

1. **Input validation, fails closed:** `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` (must be a US `+1` NANP number), `invalid_time_zone` (checked only for marketing).
2. **Opt-out:** if `optedOutAt` is set, the text is blocked with `opted_out`, for both kinds. An unparseable timestamp gives `invalid_opt_out_timestamp`. This follows CTIA (a STOP ends the program) and 47 CFR 64.1200(a)(10) on revocation. The gate blocks immediately, which is stricter than the rule's 10-business-day window.
3. **Transactional:** allowed. No marketing consent is needed and quiet hours do not apply.
4. **Marketing only:**
   - `marketing_consent_missing` unless `marketingConsent === true` (47 CFR 64.1200(a)(2), prior express written consent).
   - `marketing_missing_opt_out_instructions` unless the body contains the word STOP (CTIA messaging principles).
   - `telemarketing_quiet_hours` unless the customer's local hour is 8:00–20:59 (47 CFR 64.1200(c)(1)). Local time comes from `Intl` with the customer's IANA zone, so the server's zone has no effect. Tests cover DST and a `TZ` change.

**Decisions for you or counsel to confirm:**

- **Transactional texts are blocked after STOP.** Under CTIA, a STOP ends the program, so a login code sent to a customer who replied STOP would be blocked. If you want codes to keep flowing, that needs a separate path, and counsel should confirm it.
- **Kind is trusted from the caller.** The function cannot tell whether the AI agent labeled a sales text as transactional. Your code that picks `kind` is what counts.
- **Written consent is a flag.** `marketingConsent: true` is taken as proof of prior express written consent. Whoever sets the flag must make sure the consent was actually written and clearly disclosed.
- **The citations are from memory.** I did not check the current text of 47 CFR 64.1200 or the CTIA guidelines against the source. Counsel should verify the subsection numbers, especially (a)(10), before relying on them.
