I wrote `bot.mjs` in the working directory. All checks pass (`node` run of a test script kept outside the repo, plus a syntax check). Nothing was sent.

**What `checkSms(message, now)` returns**

| Reason | Rule it enforces |
|---|---|
| `invalid_input` | Bad `kind`, empty or non-string `body`, bad `now`, or a malformed `optedOutAt`. Fails closed. |
| `invalid_phone_number` | Not a US (NANP) number in `+1XXXXXXXXXX` form. |
| `invalid_time_zone` | `timeZone` is not a valid IANA zone (marketing only). |
| `opted_out` | Marketing text after a STOP reply. TCPA revocation of consent, 47 CFR 64.1200(a)(10). |
| `opted_out_transactional` | Transactional text after a STOP reply. See decision 1 below. |
| `no_marketing_consent` | Marketing text without `marketingConsent === true`. Prior express written consent, 64.1200(a)(2). |
| `quiet_hours` | Marketing text before 8:00 or at/after 21:00 on the customer's clock. 64.1200(c)(1). |
| `missing_opt_out_text` | Marketing body does not contain the word STOP. CTIA opt-out instructions. |

Allowed returns `{ allowed: true, reason: null }`. Transactional texts with no STOP reply are always allowed, because the customer's own action supplies consent.

**How the rules are applied**
- Quiet hours use `Intl` with the customer's `timeZone` and never read the server zone. The test suite runs under a different `TZ` to confirm this.
- A STOP reply blocks immediately, which is stricter than the 10-business-day window.
- The function reads `now` and does no I/O, so it is deterministic.

**Decisions for you and counsel**
1. **STOP also blocks transactional texts** (`opted_out_transactional`). I chose this because CTIA treats STOP as ending the whole messaging program. Some teams allow login codes after STOP. If you want that, it is a one-line change, but counsel should sign off.
2. **I did not check the current text of 47 CFR 64.1200.** The revocation and consent rules have changed in recent years, and parts have been litigated. Please have counsel confirm the citations and the revocation timing against the current eCFR before this goes in front of them.
3. **No Do-Not-Call registry check.** The input has no DNC data, and 64.1200(c)(2) requires scrubbing marketing calls against the national registry. The gate does not cover this yet. It needs a separate data source.
4. **Written consent is a boolean.** The function trusts `marketingConsent` and does not verify how the consent was captured. The sign-up flow has to record a clear, conspicuous disclosure, and counsel should check that.
5. **Sample numbers are allowed.** The `555-01XX` range is not blocked, because your example number `+13125550142` uses it.
