I wrote `bot.mjs` in the work directory. `checkSms(message, now)` is synchronous, has no dependencies, and returns `{ allowed, reason }`. I ran 19 behavior tests under server time zones UTC, Asia/Tokyo and Pacific/Honolulu, and all passed. I did not run it under Node 22 because only Node 24 is installed here. It uses only long-standing APIs, so it should run on 22. Nothing was sent.

**Block codes, checked in this order:**
- `invalid_message`, `invalid_timestamp`, `unknown_message_kind`: malformed input (fails closed).
- `invalid_phone_number`: not `+1` followed by NANP digits, with area code and exchange starting 2–9.
- `empty_body`
- `opted_out`: `optedOutAt` is set. Applies to **both** kinds.
- Marketing only:
  - `no_marketing_consent`: `marketingConsent` is not `true`.
  - `missing_opt_out_language`: body has no "STOP" keyword.
  - `invalid_time_zone`: the IANA zone is not recognized (fails closed).
  - `quiet_hours`: local hour is before 8:00 or at/after 21:00 in the customer's `timeZone`.

Transactional texts skip the consent, opt-out-language and quiet-hours checks. They still honor STOP. The local hour comes from `Intl` with the customer's zone passed explicitly, so the server's zone never matters.

**Legal basis, as written in the file header:**
- 47 CFR 64.1200(a)(2): prior express written consent for marketing texts.
- 64.1200(c)(1): 8 a.m.–9 p.m. local time for telemarketing. I applied this to marketing texts.
- 64.1200(a)(10): revocation must be honored.
- CTIA Messaging Principles: opt-out instructions in marketing messages.

**Decisions for your lawyers to confirm:**
- **STOP blocks transactional texts too.** The data has no category field, so I took the conservative reading. The FCC's "revoke-all" provision in (a)(10) has been delayed, and a search turned up reports of a September 2026 FCC action that changes it. I could not confirm the adopted text. Sources: [Manatt](https://www.manatt.com/insights/newsletters/client-alert/fcc-replaces-revoke-all-rule-and-permits-callers-to-designate-an-exclusive-revocation-method), [Consumer Financial Services Law Monitor](https://www.consumerfinancialserviceslawmonitor.com/2026/01/fcc-further-extends-effective-date-for-tcpa-revoke-all-rule/), [Burr](https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027). If counsel says a STOP to marketing should not block login codes, that is a one-line change, but it needs its own reason code.
- **Quiet hours on marketing only.** Transactional texts are never delayed, so a login code at night still goes out.

**Limits:**
- The function cannot tell whether a "transactional" body is really marketing. Classification is the caller's job.
- It does not check that consent was recorded with a timestamp or proof. Keep those records in your consent system.
- It does not check the sender identification that some rules require.

**On the Knock skill:** I read its implementation rules. Its TCPA summary is thin, and its "don't use auto-dialer for marketing" line is misleading. Marketing texts can be sent with automated tools if consent is in place. I built the rules from the regulation text above, not from that summary.
