I wrote `bot.mjs` in the work directory. It exports `checkSms(message, now)`, has no dependencies, and sends nothing. All 22 behavior checks pass, and the same quiet-hours result holds with the server set to UTC, Tokyo, and Los Angeles. I ran it on Node v24.13.0, not Node 22. The checks are in `/tmp/sms-gate-check/check.mjs`, outside the repo.

**Rules, checked in this order (first failure wins):**

| Code | Applies to | Rule basis (from my reading of the rules; verify before the lawyers rely on it) |
|---|---|---|
| `invalid_message`, `invalid_now`, `unknown_kind`, `empty_body`, `invalid_phone_number`, `invalid_time_zone`, `invalid_opt_out_timestamp` | both | Input validation. Malformed input fails closed. Phone must be `+1` plus a valid 10-digit NANP number. A `optedOutAt` after `now` counts as malformed. |
| `promotional_content_labeled_transactional` | transactional | Promotional wording needs the marketing rules. |
| `opted_out` | marketing | A STOP reply revokes marketing consent (47 CFR 64.1200(a)(10); CTIA). |
| `no_marketing_consent` | marketing | Prior express written consent is required (47 CFR 64.1200(a)(2)). |
| `missing_opt_out_language` | marketing | Body must contain "STOP" (CTIA). |
| `quiet_hours` | marketing | Sends only from 08:00 up to 21:00 in the customer's `timeZone` (47 CFR 64.1200(c)(1)). Local time comes from `Intl` with the explicit zone, so the server's zone doesn't matter. |

**Decisions you or counsel should confirm:**

- **STOP does not block transactional texts.** A customer who replied STOP still gets login codes and delivery updates they asked for. Counsel should confirm this. The stricter alternative is one line to change.
- **The promo check is a keyword list** (sale, coupon, % off, and so on). It catches obvious mislabels, not every promotion. The AI agent can still disguise marketing copy, so the list is a backstop, not a guarantee.
- **21:00 is blocked.** The cutoff is treated as "at or after 21:00," which is the conservative reading of "after 9 p.m."
- **Citations are from memory.** I did not check them against the current eCFR or CTIA text. Please have counsel verify the subsection numbers.
- **Not covered:** the sender-identification requirement, the rule on how long an opt-out takes to process, and the carrier-side filtering. The function doesn't know the brand name, so it can't check identification. The opt-out rule is enforced immediately rather than within a window, which is stricter than required.

The skill's general guidance agreed with the design: opt-out instructions for marketing, consent records, and honoring opt-out. It has no SMS-specific code, so the rule details above come from the TCPA and CTIA sources, not from the skill.
