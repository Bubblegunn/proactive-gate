`bot.mjs` is written and all 19 tests pass. Nothing was sent.

**Files** (in `work/courier-inv-g1-2/`)
- `bot.mjs`: exports `checkSms(message, now)`. No dependencies, no I/O.
- `bot.test.mjs`: run with `node --test ./bot.test.mjs`.

**Rules, in the order they are checked** (the first failing rule sets `reason`):

| Code | Applies to | Rule |
|---|---|---|
| `opted_out` | both | `optedOutAt` is set (customer replied STOP). CTIA: after STOP, send nothing except an opt-out confirmation. |
| `no_marketing_consent` | marketing | `marketingConsent` is false. 47 CFR 64.1200(a)(2): prior express written consent for telemarketing texts. |
| `missing_opt_out_language` | marketing | Body has no "reply/text/send STOP" instruction. CTIA: marketing must say how to opt out. |
| `outside_quiet_hours` | marketing | Local time in `timeZone` is before 08:00:00 or after 21:00:00. 47 CFR 64.1200(c)(1). |

Transactional texts skip the last three rules. Quiet hours use the customer's zone through `Intl`, so the server's TZ has no effect. The tests check that directly, along with the 08:00 and 21:00 boundaries and DST.

Invalid input (bad kind, empty body, unknown zone, bad date) throws a `TypeError`. It returns no reason code, since it is a caller bug rather than a customer decision.

**Verification:** 19/19 tests pass on Node v24.13.0. The machine has no Node 22, so I did not run it on 22. The APIs used (`Intl` with `hourCycle`, `formatToParts`) are standard in 22, but that is unverified.

**Points for your lawyers** (these are the places where this code is a simplification, not legal advice):
- `marketingConsent` is a boolean. The function does not check that the sign-up disclosure was clear or that consent was written.
- STOP blocks all messages to the customer, not just marketing. That is the conservative CTIA reading. Your policy on confirmation texts after STOP is not modeled.
- Quiet hours use the customer's home zone. The TCPA refers to the called party's location, so a traveling customer may be handled wrongly.
- Revocation timing (the FCC 10-business-day rule for honoring opt-outs) is not modeled. The function treats any `optedOutAt` as effective immediately.
- The opt-out check is a presence check on the body. It does not verify wording beyond the "reply/text/send STOP" pattern.
- A "transactional" message that contains promotional content is not detected. It would pass as transactional.

I loaded the Courier skill as you asked, but this function makes no Courier SDK or API calls, so none of its patterns applied.
