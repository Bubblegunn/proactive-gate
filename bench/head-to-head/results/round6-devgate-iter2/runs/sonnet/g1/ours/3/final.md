`bot.mjs` is written and exports `checkSms(message, now)`. I ran 12 cases with the process time zone forced to Asia/Tokyo, and all passed. Nothing is sent.

**Rules, in the order checked**

| Order | Message kind | Reason code | Blocks when | Rule |
|---|---|---|---|---|
| 1 | any | `unknown_kind` | `kind` is neither `marketing` nor `transactional` | Held, because the kind is unknown |
| 2 | marketing | `opted_out` | `optedOutAt` is set | STOP must be honored (64.1200(a)(10), CTIA); this beats every other marketing rule |
| 3 | marketing | `no_marketing_consent` | `marketingConsent` is not exactly `true` | Prior express written consent (64.1200(a)(2)) |
| 4 | marketing | `invalid_time_zone` | `timeZone` is missing or not an IANA zone, or `now` is an invalid Date | Held, because the local time is unknown |
| 5 | marketing | `quiet_hours` | local time is outside 08:00 (included) to 21:00 (excluded) | Calling hours in 64.1200(c)(1) |

Transactional texts always go out. The customer triggered them, so they are not marketing solicitations. They skip the consent, opt-out and time-window checks.

Local time comes from `Intl` with the customer's IANA zone, so the server's own zone and daylight-saving changes don't matter.

**Assumptions your lawyers should confirm**
- A STOP reply is treated as covering marketing only. A login code the customer just asked for still goes out after STOP.
- Any non-empty `optedOutAt` counts as opted out, even if it isn't a valid date.
- `optedOutAt` and `marketingConsent` are the only opt-out and consent inputs. There is no field for a later START or re-opt-in, so a customer who replies START must have `optedOutAt` cleared in your data.

**Not enforced**
- CTIA's recommendation that marketing texts carry a "Reply STOP to opt out" notice and the brand name. Your request doesn't make the body a blocking rule, so body checks are left out.
- Stricter state rules (for example Florida or Oklahoma calling hours), and the one-time STOP confirmation text.

**Checked and not checked**
- The 12 cases covered the 07:59, 08:00, 20:59 and 21:00 boundaries, the daylight-saving end date (2026-11-01), opt-out, missing consent, a bad zone, and both transactional cases. A normal afternoon marketing text is allowed.
- Not checked: invalid `now`, malformed `message` or `to` objects, and the `unknown_kind` code.

I didn't add a separate test file.
