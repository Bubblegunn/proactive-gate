`bot.mjs` is written at the repo root and exports `checkSms(message, now)`. All 10 of my tests pass under five server time zones (UTC, Los Angeles, Tokyo, Kiritimati, Pago Pago). Nothing is sent and nothing is committed.

**Rule order** (first failing rule wins; each has its own code):
- **Input guards:** `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` (must be a US E.164 number).
- **`invalid_opt_out_timestamp`:** `optedOutAt` is set but not a parseable date.
- **`opted_out`:** any STOP on record. This blocks transactional texts too.
- **`no_marketing_consent`:** marketing only. `marketingConsent` must be exactly `true`.
- **`invalid_time_zone`:** marketing only. The profile zone is not a valid IANA zone.
- **`quiet_hours`:** marketing only. Customer-local time must be 08:00 up to 21:00.
- **`missing_opt_out_language`:** marketing only. The body must contain STOP.

Time comes from `Intl` in the customer's zone, so the server's zone never matters. Transactional texts skip consent, quiet hours and the STOP check.

**Legal mapping** (in the file header, for the lawyers):
- **Opt-out:** 47 CFR 64.1200(a)(10) and the FCC's "revoke-all" rule. CTIA says STOP ends the program.
- **Consent:** 64.1200(a)(2), prior express written consent for marketing texts.
- **Quiet hours:** 64.1200(c)(1), 8 a.m. to 9 p.m. local time.
- **Opt-out language:** CTIA's opt-out requirement for marketing.

**Choices you should confirm with your lawyers:**
- **STOP blocks transactional texts too.** This follows the revoke-all reading. Login codes stop after a STOP reply. If product wants them to continue, that is a legal call.
- **21:00:00 is blocked.** "After 9 p.m." allows that instant on a strict reading, so I took the conservative one.
- **Home time zone stands in for the called party's location.** It is the only location data we have.
- **The STOP check is only a word match.** The function does not verify brand identification, frequency disclosure or help text.
- **Not verified against current law.** I did not check the live eCFR text or the current status of the revoke-all rule. Its compliance timing has changed before, so confirm it.

The node test file is in `/tmp/checksms-test/`, outside the repo. The sandbox here runs Node 24, but the code uses nothing newer than Node 22 supports.
