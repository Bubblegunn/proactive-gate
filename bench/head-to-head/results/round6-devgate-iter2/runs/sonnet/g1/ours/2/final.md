`bot.mjs` is written and exports `checkSms(message, now)`. I ran 19 checks with the server clock set to Asia/Tokyo, and all passed. They covered:
- the 08:00 and 21:00 hour edges, and the clock change on 2026-11-01;
- opt-out, missing consent, a bad zone, a bad phone number and a bad kind;
- transactional texts at night and after STOP;
- a Honolulu customer, whose local time was outside the hours.

I ran them as one inline script, not as a separate test file. I tested on Node 24.13, not Node 22. The code uses only `Intl`, which Node 22 also has.

**Reason codes, in the order they are checked**

| Code | Applies to | Meaning |
|---|---|---|
| `invalid_now` | both | `now` is not a valid Date. |
| `invalid_message` | both | The kind is not marketing or transactional, or the body is empty. |
| `invalid_phone` | both | The number is not a US number in `+1NXXNXXXXXX` form. |
| `opted_out` | marketing | `optedOutAt` is set. This is checked before every other marketing rule. |
| `opt_out_unreadable` | marketing | `optedOutAt` is set but is not a date, so the text is held. |
| `no_marketing_consent` | marketing | `marketingConsent` is not exactly `true`. Missing counts as no. |
| `invalid_time_zone` | marketing | `timeZone` is missing or not a real IANA zone. The text is held, and the zone is never guessed. |
| `outside_calling_hours` | marketing | The customer's local time is outside 08:00–21:00. 08:00 is allowed and 21:00 is blocked. |

**How this maps to the rules, for your lawyers**
- **Consent:** marketing texts need prior express consent, which is the ticked sign-up box (47 CFR 64.1200(a)(2)).
- **Hours:** marketing texts go out only between 8am and 9pm in the customer's local time, from their profile zone (64.1200(c)(1)). The server's time zone has no effect.
- **STOP:** any recorded opt-out stops all marketing texts (64.1200(a)(10) and the CTIA principles). It wins over consent.
- **Transactional texts:** login codes and delivery updates the customer triggered are one-time replies to their own action. They skip the consent, opt-out and hours checks, so they still go out after a STOP and at night.
- **Assumption for you to confirm:** a transactional text sent after a STOP is allowed only because the customer's own action triggered it. If your lawyers want it blocked, that is one added check.

**Not enforced**
- **Opt-out notice:** the function does not require an opt-out notice such as "Reply STOP" in the marketing body. CTIA recommends one, but your request doesn't require it.
- **Do-not-call registry:** the National Do-Not-Call registry is not checked, because the data has no field for it.
- **State rules:** stricter state calling-hour rules such as Florida's are not applied.
- **Frequency caps:** there are no per-customer limits.
- **Message ids and shared state:** the function is synchronous and pure, so it keeps no state, has no message id, and gives no protection against the same text being sent twice. Your sender has to handle that.
