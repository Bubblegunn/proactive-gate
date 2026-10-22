`bot.mjs` is written in the project directory. It exports `checkSms(message, now)` with no dependencies. It is synchronous, keeps no state and sends nothing.

I checked it with a script in `/tmp/bot-check.mjs`, run with the server zone set to Tokyo. All cases passed:
- A normal marketing text goes through.
- 07:59 is blocked and 08:00 is allowed.
- 20:59 is allowed and 21:00 is blocked.
- Hawaii, where it is 07:00, is blocked.
- 08:00 right after daylight saving ends is allowed.
- Each blocking code below was triggered at least once.

I did not use the proactive-gate library. Its skill says to write the gate inline when a single function is requested, and the budgets and state it provides aren't needed here.

**Rules applied** (the code comments carry the same citations):

| Order | Code | Applies to | Rule |
|---|---|---|---|
| 1 | `invalid_time`, `invalid_message`, `invalid_kind`, `empty_body` | both | The input is malformed. |
| 2 | `invalid_phone` | both | The number is not a valid US `+1` number (area code and exchange start with 2–9). |
| 3 | `opted_out` | marketing | The customer replied STOP. This follows 47 CFR 64.1200(a)(10) and CTIA. |
| 4 | `no_marketing_consent` | marketing | `marketingConsent` is not exactly `true`. This follows 64.1200(a)(2), which requires prior express written consent. |
| 5 | `unknown_time_zone` | marketing | The zone is missing or invalid. |
| 6 | `quiet_hours` | marketing | The local time is outside 08:00 to 21:00. This follows 64.1200(c)(1). 08:00 is included and 21:00 is excluded. |
| 7 | `missing_opt_out_notice` | marketing | The body has no standalone word "STOP". This follows CTIA. |

Local time comes from the profile's IANA zone through `Intl`, so the server's own zone has no effect. Rules 3 to 7 apply only to marketing. Transactional texts only go through checks 1 and 2.

**Choices your lawyers should confirm:**
- **Transactional after STOP:** transactional texts still go out after a customer replies STOP. I treated them as customer-requested, not telemarketing. If counsel reads a STOP as covering everything, add an opt-out check for transactional too.
- **Fail-closed inputs:** a bad or missing time zone, an unparseable `optedOutAt` and a missing consent flag all block marketing.
- **Opt-out notice:** `missing_opt_out_notice` is stricter than the FCC requires. It reflects the CTIA expectation that marketing texts say how to opt out, and the AI agent has to write "Reply STOP to opt out" into every body.
- **Not covered:**
  - The federal Do Not Call registry.
  - State rules. Florida and Oklahoma stop marketing texts at 8 p.m., not 9 p.m. A customer in those states would need a stricter window.
  - Carrier content and length rules.
  - Sender identification in the body.
  - The one allowed confirmation reply to a STOP.
  - Customers who have moved away from their profile's home time zone.
