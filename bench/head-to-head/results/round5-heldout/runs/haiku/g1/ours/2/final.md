I wrote `bot.mjs` in the work directory and ran a self-check. All 17 cases pass with the server time zone set to UTC, Asia/Tokyo and America/Los_Angeles. The function sends nothing and has no dependencies.

**How it decides (in order):**
1. Bad input is blocked with its own code: `invalid_now`, `invalid_message_kind`, `invalid_body`, `invalid_phone` (must be +1 and 10 digits). The `invalid_opt_out_record` code covers an `optedOutAt` that is not a parseable date.
2. `opted_out`: any non-null `optedOutAt` blocks both kinds.
3. Transactional texts pass after that. No consent or hour rule applies to them.
4. Marketing texts need `marketingConsent === true` (`no_marketing_consent`, and absent counts as no).
5. The body must contain "Reply STOP" or "Text STOP" (`missing_opt_out_instructions`).
6. The zone must be a valid IANA name (`invalid_time_zone`). Local time comes from `Intl` with that zone, so the server zone is never read.
7. Local time from 08:00 (inclusive) to 21:00 (exclusive) passes. Otherwise the result is `quiet_hours`.

**Legal basis for your lawyers.** I worked from my knowledge of these rules and did not re-read the CFR text or the CTIA document, so please check the citations:
- 47 CFR 64.1200(c)(1): the 8 a.m. to 9 p.m. calling window in the called party's local time. This applies to telemarketing, so I did not apply it to transactional texts.
- 47 CFR 64.1200(a)(2): prior express written consent for autodialed telemarketing texts to wireless numbers. A ticked box stands in for it here. Whether that is enough depends on the disclosure and E-SIGN requirements, which is a legal question. The code only checks the flag.
- CTIA Messaging Principles: opt-out instructions in marketing texts, and honouring STOP.

**Decisions you should confirm:**
- I block transactional texts after a STOP as well. That is the conservative reading. The alternative is to let login codes through, which some providers do. It is a legal choice, so I did not make it silently.
- The opt-out check is a text match, so a marketing body that says "reply stop" in another phrasing would be blocked. It does not check for brand identification, which CTIA also asks for.
- I did not use the proactive-gate library. The function is stateless and the decision needs no state, so the library's state and retry machinery would only add code. Nothing in it tracks frequency caps or send budgets.
