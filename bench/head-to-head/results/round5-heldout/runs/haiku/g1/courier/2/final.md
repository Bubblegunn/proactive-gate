`bot.mjs` is written, exports `checkSms(message, now)`, and passes its 16 tests with the server time zone set to both the default and Asia/Tokyo. Nothing is sent: the function only returns a decision.

Files in `work/courier-g1-2/`:
- `bot.mjs`: the gate. No dependencies, ES module, uses only `Intl` and `Date`.
- `bot.test.mjs`: tests run with `node --test bot.test.mjs`.

**Rules, in the order they are checked**

Both kinds:
1. `invalid_send_time`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`: malformed input fails closed.
2. `invalid_us_phone`: the phone must match `+1` followed by a 10-digit NANP number (area code and exchange each start with 2–9).

Transactional (login codes, delivery updates): allowed after step 2. No consent, time window, or STOP check applies, because the customer triggered the message.

Marketing:
3. `no_marketing_consent`: `marketingConsent` must be exactly `true`. Missing or other values block. Basis: 47 CFR 64.1200(a)(2), prior express written consent.
4. `opted_out`: any non-null `optedOutAt` blocks. `opt_out_status_unknown` blocks when `optedOutAt` is not a parseable date. Basis: 64.1200(a)(10), revocation by any reasonable means.
5. `invalid_time_zone`: `timeZone` must be a valid IANA zone.
6. `outside_marketing_hours`: allowed from 08:00 local (inclusive) until 21:00 local (exclusive), in the recipient's zone. The server clock is never used. Basis: 64.1200(c)(1).
7. `missing_opt_out_language`: the body must contain the uppercase word `STOP`. Basis: CTIA Messaging Principles.

Each blocking rule returns a different snake_case code. A test checks that they are all distinct.

**Judgment calls to confirm with counsel**
- **STOP does not block transactional texts.** A login code the customer just requested is not unsolicited marketing. If your lawyers want STOP to silence every message on the number, change step 4 to run for both kinds.
- **21:00 exactly is blocked** (the window is [08:00, 21:00)). The rule says "after 9pm", so 21:00:00 is arguably allowed; I chose the stricter reading.
- **`STOP` check is a presence test.** It does not check that the text names the sender, and it accepts any uppercase `STOP` in the copy. It is a basic check, not a full CTIA compliance check.
- **Citations are from memory.** I did not check them against the current CFR text or the CTIA guide in this session. Please verify the subsection numbers before the legal review.
- **`marketingConsent` is a boolean.** The function trusts whatever the caller stores. The consent record itself must be a written (including electronic) record, and that is enforced upstream, not here.
