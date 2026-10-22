`bot.mjs` is written in the project directory and passes all 14 checks under three server time zones (UTC, Asia/Tokyo, America/Los_Angeles). It sends nothing and keeps no state. I did not use the proactive-gate library: this is a single pure function, so a library would add nothing.

**Reasons, in the order they are checked:**
- `invalid_now`: `now` is not a valid Date.
- `unknown_kind`: `kind` is neither `marketing` nor `transactional`.
- `invalid_recipient`: `to` is missing.
- `opted_out`: `optedOutAt` is a valid ISO timestamp. This blocks both kinds.
- `opt_out_status_unknown`: `optedOutAt` is neither null nor a valid ISO timestamp. Held.
- Transactional texts are allowed after that.
- `no_marketing_consent`: `marketingConsent` is not exactly `true`.
- `invalid_time_zone`: `timeZone` is missing or unknown. Held.
- `outside_marketing_hours`: local time is before 08:00 or at/after 21:00 in the customer's `timeZone`. The start minute is allowed and the end minute is blocked.

Local time comes from `Intl.DateTimeFormat` with the customer's IANA zone, so the server's zone does not matter. The check passes across the November 2026 DST change.

**Decisions for your lawyers to confirm:**
- **Opt-out applies to transactional texts too.** A STOP blocks login codes and delivery updates as well. The FCC's 2024 revocation rule was read as covering all robotexts from a sender. I could not confirm its current legal status, so please verify it. If lawyers say transactional texts survive a STOP, the change is one line in `checkSms`.
- **The 08:00–21:00 window is applied to marketing texts.** 47 CFR 64.1200(c)(1) is written for telephone solicitations. Applying it to texts follows the FCC's usual reading, but that is a legal call.
- **Transactional texts have no time window.** Login codes at night are allowed.

**Not enforced:** CTIA's opt-out and identification wording in the body of marketing texts. The request names CTIA as a principle, not a legal requirement, and a single message's body cannot show whether the program's first message already carried that wording. The function allows the message and does not check the body. Your send path needs to ensure that wording is present.

**Not included:** an empty-body check and a check that the phone number is a US number. The request did not ask for either.

Files are in `work/ours-g1-2/`:
- `bot.mjs`
