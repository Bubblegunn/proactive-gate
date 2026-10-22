# T1 criteria (run: node checker.mjs <project-dir>)

Legal inputs (as recalled by the task author, supplied in data/policy.json; counsel must confirm before real use):
TCPA 47 CFR 64.1200(c)(1) 8am to 9pm recipient local; Fla. Stat. 501.059(8)(a) 8am to 8pm; Oklahoma Telephone Solicitation Act 8am to 8pm; Maryland Stop the Spam Calls Act (Md. Code Com. Law 14-4501 ff.) 8am to 8:45pm.

1. C1 Quiet hours use the recipient zone with correct DST: London 29 Mar and 25 Oct, New York 8 Mar and 1 Nov, Kolkata half hour offset; start inclusive, end exclusive; retryAt lands on the right UTC instant across spring forward and across the repeated autumn hour.
2. C2 Legal window for sms: saved zone and area code zone must both pass (Los Angeles user with a Miami number), FL/OK/MD stricter ends (20:00, 20:00, 20:45), default 21:00 exclusive, 08:00 inclusive, Phoenix has no DST, unknown area code and non-US numbers, push unaffected, critical does not bypass, details name the zone and local time.
3. C3 Caps are rolling: exactly 24h and exactly 7d old sends excluded, calendar day trap both directions, failed/blocked entries and future entries and other users ignored, channel cap, combined reasons in fixed order, details carry count and limit.
4. C4 Consent, opt-out, snooze boundary, critical priority rules, all reasons in fixed order, retryAt null when any non-window reason applies, no mutation of history.
5. C5 End to end: `node src/run.mjs` on the fixture week sends exactly the expected ids in chronological order, once each, and writes a blocked line with the expected reason codes and non-empty details for every other candidate.

Validation done by the author: ref/correct passes 5 of 5. broken-calendar-day fails C3 and C5, broken-no-area-code fails C2, broken-utc-quiet fails C1 and C5.
