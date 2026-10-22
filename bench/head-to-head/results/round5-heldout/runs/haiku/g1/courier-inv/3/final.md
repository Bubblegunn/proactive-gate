I wrote `bot.mjs` with `checkSms(message, now)` and a test file. All 10 tests pass under four server time zones (UTC, Los Angeles, Tokyo, Kiritimati). I ran them on Node 24 (the Node 22 target isn't installed here). Nothing was sent. The Courier skill covers the Courier API, which this function doesn't call, so I didn't use its references.

**Files** (in `work/courier-inv-g1-3/`):
- `bot.mjs`: the function, no dependencies.
- `bot.test.mjs`: `node --test bot.test.mjs`.

**Rules, in check order.** The first failing rule sets `reason`:

| Code | Rule |
|---|---|
| `invalid_message` | Malformed input. Fails closed. |
| `invalid_phone` | Not a US E.164 number (`+1`, valid area code and exchange). |
| `invalid_now` | `now` is not a valid Date. |
| `invalid_opt_out_timestamp` | `optedOutAt` is set but unparseable. Fails closed. |
| `opted_out` | Customer replied STOP. Blocks both kinds. |
| `invalid_time_zone` | `timeZone` is not a known IANA zone. |
| `no_marketing_consent` | Marketing text, `marketingConsent` is false. |
| `quiet_hours` | Marketing text, customer's local time is 21:00–07:59. |
| `missing_opt_out_language` | Marketing body has no uppercase `STOP`. |

Quiet hours use `Intl` with the customer's zone, so the server's zone has no effect. The tests check this.

**Mapping to the rules you named:**
- **47 CFR 64.1200 quiet hours:** 8 a.m.–9 p.m. local time at the called party's location. We use the profile's home zone as a proxy. That's a gap if customers travel.
- **Consent:** The `marketingConsent` flag is an input. The function trusts it. The FCC's written-consent definition is narrower, so your lawyers should confirm the checkbox meets it.
- **Revocation:** STOP sets `optedOutAt`, and the function honors it immediately. Other revocation words (for example "unsubscribe" or "cancel") have to be mapped to `optedOutAt` upstream.
- **CTIA:** The `STOP` check on marketing bodies follows the opt-out-instruction practice. I did not verify the CTIA document text.

**Decisions for you or your lawyers to confirm:**
1. **STOP blocks transactional texts too.** Login codes stop after a STOP. This is the conservative choice, but it may hurt users who need codes. Changing it is a one-line edit.
2. **Transactional texts skip quiet hours and consent.** The function cannot check whether a "transactional" body is secretly marketing.
3. **The `STOP` check is case-sensitive**, so "stop" in ordinary text does not count as an opt-out instruction.

**What I did not verify:** I did not retrieve the current eCFR text of 47 CFR 64.1200. The search turned up a Federal Register note from August 2025 that changed the written-consent definition, a partial FCC stay on revocation, and an unclear revocation deadline. The eCFR text and the CTIA principles need a check before the lawyers rely on any of this.

Sources I used for the above:
- [Federal Register, 2025-16641 (Aug. 29, 2025)](https://www.govinfo.gov/content/pkg/FR-2025-08-29/html/2025-16641.htm)
- [FCC DA 25-621](https://docs.fcc.gov/public/attachments/DA-25-621A1.txt)
- [Nixon Peabody on the partial stay of the revocation rules (Apr. 2025)](https://nixonpeabody.com/insights/alerts/2025/04/11/fcc-partially-delays-new-tcpa-consent-revocation-rules)
- [Privacy World on TCPA quiet hours (Mar. 2025)](https://www.privacyworld.blog/2025/03/new-class-action-threat-tcpa-quiet-hours-and-marketing-messages/)
