I wrote `bot.mjs` at `work/ours-g1-3/bot.mjs`. It exports `checkSms(message, now)`, returns `{ allowed, reason }`, and sends nothing. All 15 inline checks pass on Node v24.13.0. I did not run it on Node 22 itself, but it uses only long-standing APIs (`Intl` with `hourCycle`, `Date.parse`, optional catch binding).

**Block codes** (each rule has its own code):
- `invalid_message`, `invalid_now`, `unknown_kind`, `invalid_phone`: malformed input. Phone must be US E.164 (`+1` plus a valid area code and exchange).
- `opt_out_unknown`: `optedOutAt` is missing entirely. Null means never opted out.
- `invalid_opt_out_timestamp`: `optedOutAt` is a string that does not parse.
- `opted_out`: marketing text after a recorded STOP.
- `marketing_consent_missing`: `marketingConsent` is not exactly `true`.
- `invalid_time_zone`: `timeZone` is not a valid IANA zone. The text is held, not guessed.
- `quiet_hours`: marketing text outside 08:00 (inclusive) to 21:00 (exclusive) in the customer's local time. Daylight saving is handled by `Intl`.

**How it maps to the rules:**
- **47 CFR 64.1200(a)(2)** (prior express written consent): marketing requires `marketingConsent === true`.
- **47 CFR 64.1200(c)(1)** (8 a.m. to 9 p.m. local time for telephone solicitations): the window check for marketing.
- **Opt-out**: `optedOutAt` blocks marketing. It is checked before consent.
- **CTIA Messaging Principles**: treated as guidance. Not enforced: STOP wording in the body, HELP, message length. The lawyers should decide whether any of these must become blocks.
- **Transactional** texts are allowed after a valid phone check. They skip consent, opt-out and quiet hours, because the customer triggered them.

**Decisions for your lawyers:**
1. **STOP and transactional texts.** After a STOP, transactional texts still go out, because I applied the opt-out only to marketing. I am not sure this is right. The FCC's revoke-all provision in 64.1200(a)(10) may require a STOP to cover informational texts too, and I did not verify its current status. Changing this is a one-line edit.
2. **Quiet hours on transactional texts.** I did not apply the 8-to-9 window to login codes. Blocking them at night would strand customers. Counsel should confirm.
3. **Retry times.** The contract returns only a code, so the function cannot say when a held text may go. Support must map codes to wording and, for `quiet_hours`, compute the next 08:00 locally.

**Not included:**
- **State and idempotency.** The function is pure, and everything it needs is in the input, so it has no state store. The sending layer must handle duplicate sends.
- **Proactive-gate library.** I did not use it. Its per-user state and retry-time output do not fit this fixed return shape, and the task asked for one function.

This is an engineering implementation, not legal advice. Please have counsel review the decisions above before you rely on it.
