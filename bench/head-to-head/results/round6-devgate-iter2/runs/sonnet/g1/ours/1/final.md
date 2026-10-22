`bot.mjs` is written and exports `checkSms(message, now)`. I ran 15 checks with the process time zone set to `Pacific/Kiritimati`, and all passed. I did not use the proactive-gate library, because you asked for one dependency-free function and the skill's default is an inline gate.

**What the function checks, in order**

| Order | Rule | Reason code | Legal basis |
|---|---|---|---|
| 1 | `now` is not a valid Date | `invalid_now` | input check |
| 2 | Message or recipient missing | `invalid_message`, `invalid_recipient` | input check |
| 3 | `kind` is not `marketing` or `transactional` | `invalid_kind` | input check |
| 4 | Phone is not a valid US `+1` number | `invalid_phone` | input check |
| 5 | Transactional texts that pass 1–4 are allowed | none | triggered by the customer, so TCPA marketing consent and calling hours do not apply |
| 6 | Marketing: `optedOutAt` is set to anything non-null | `opted_out` | a STOP reply revokes consent (47 CFR 64.1200(a)(10); CTIA opt-out principle) |
| 7 | Marketing: `marketingConsent` is not exactly `true` | `no_marketing_consent` | prior express written consent for automated marketing texts (64.1200(a)(2)) |
| 8 | Marketing: `timeZone` is missing or not a valid IANA zone | `invalid_time_zone` | the function can't confirm the local hour, so it holds the text |
| 9 | Marketing: local time is outside 08:00–21:00 | `outside_calling_hours` | 64.1200(c)(1) |

- **Opt-out order:** the opt-out check runs before consent and hours, so a customer who replied STOP always gets `opted_out`.
- **Calling hours:** the window includes 08:00 and excludes 21:00. It is computed from `now` and the customer's zone with `Intl`, so the server's time zone and daylight-saving changes don't matter. The tests covered the Chicago boundaries and the November 1 clock change.
- **Transactional texts:** they ignore opt-out, consent and hours. A login code to someone who texted STOP to marketing still goes out. I also assumed no marketing-opt-out should block a customer-triggered text. Your lawyers should confirm that.

**Choices I made that you can change**
- `optedOutAt` blocks if it is set at all, even if the string is unparseable or in the future.
- A missing or `false` `marketingConsent` blocks. It never counts as consent.
- I added the `invalid_*` codes so a malformed input never silently becomes "allowed". Support can tell them apart from the legal rules.

**Not enforced or not covered**
- **Not enforced:** body checks, meaning an opt-out notice such as "Reply STOP to end" and sender identification. CTIA recommends them, but you didn't ask for them. If you want them required, that is one extra check.
- **Not covered:** the federal and state Do Not Call lists, state laws with stricter hours (for example Florida and Oklahoma), and frequency caps. The message has no field for any of these.
- **No state:** the function keeps no state and has no redelivery handling, because it only decides and never sends. If your caller retries, it should record the decision per message id itself.
