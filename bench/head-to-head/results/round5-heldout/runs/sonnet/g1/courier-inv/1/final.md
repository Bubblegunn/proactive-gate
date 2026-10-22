`bot.mjs` is written, and it passes my checks under three different server time zones (UTC, Asia/Tokyo and America/Los_Angeles). The checks cover the quiet-hours edges, summer and winter time, a Honolulu customer, and each blocking code. Nothing was sent. The check script is `/tmp/t/test.mjs`, outside the repo.

The Courier skill's docs don't cover TCPA or CTIA rules, so I took those from the regulations as I know them. I didn't look anything up. Your lawyers should check the mapping below against the current text of 47 CFR 64.1200.

**Checks, in order** (the first one that fails sets the `reason`):

| Code | Applies to | Rule |
|---|---|---|
| `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` | both | These block when the input is malformed, because the function can't tell whether the text is lawful. The phone must be a US +1 number. |
| `opted_out` | both | `optedOutAt` is set. Under 64.1200(a)(10) a customer can revoke consent by any reasonable means, and a STOP reply is one. CTIA also says to stop messaging after STOP. |
| `no_marketing_consent` | marketing | `marketingConsent` must be exactly `true`. Under 64.1200(a)(2), automated marketing texts need prior express written consent. |
| `invalid_time_zone` | marketing | The customer's `timeZone` isn't a valid IANA zone, so the function can't check quiet hours. |
| `quiet_hours` | marketing | Under 64.1200(c)(1), no solicitation before 8 a.m. or after 9 p.m. at the customer's location. The check uses the customer's `timeZone`, never the server's. Allowed local time is 08:00:00 to 20:59:59. |

Transactional texts skip the consent and quiet-hours checks. They can go out at any hour, so a login code at 2 a.m. isn't held back. They are blocked only by invalid input or by `opted_out`.

**Decisions to confirm with your lawyers**
- **Opt-out blocks transactional texts too.** A STOP counts as revocation, and your provider would reject the send anyway (Twilio error 21610). A customer who opted out and then asks for a login code gets no text, because the function only sees `optedOutAt` and not when the request was made.
- **Any non-null `optedOutAt` blocks.** That includes a future date or a string that doesn't parse. It stays blocked until the profile clears it, and re-ticking `marketingConsent` alone does not unblock it.
- **21:00:00 exactly is blocked.** The rule says "after 9 p.m.", and I took the cautious reading.

**What the function does not check**
- **State rules:** some state laws are stricter than the federal ones, for example Florida and Oklahoma at 8 a.m. to 8 p.m.
- **Travel:** a customer who is away from their home time zone.
- **Message wording:** brand name, STOP/HELP text and similar CTIA content rules.
- **Wrong kind label:** marketing content labeled `transactional`. The caller has to label `kind` truthfully.
- **Other limits:** frequency caps and 10DLC registration.

I did not require STOP wording in marketing bodies, because the function has no way to know whether a text is the first one a customer receives. It's a one-line addition if you want it.
