`bot.mjs` is written and exports `checkSend({ user, message, now })`. I ran 24 cases through it and all passed. The cases covered the 8:00 and 21:00 local-time boundaries, summer and winter time, Tokyo and Kolkata, and bad or missing time zones. They also covered opt-outs and malformed input. Nothing is sent and the system clock is never read.

My first test run showed a bug: passing `null` as the whole argument threw. I fixed it. Null, `{}` and a `user` object whose `sms` getter throws now all return a hold.

The rules are checked in this order. The first one that applies decides the result:

| Rule | Held when |
|---|---|
| `invalid-input` | `user` or `message` is missing, or something unexpected throws |
| `invalid-now` | `now` is not a valid `Date` |
| `invalid-kind` | `kind` is not `marketing` or `transactional` |
| `empty-text` | the text is empty or only whitespace |
| `opted-out` | `optedOutAt` has any value, even an unparseable or future one |
| `no-consent` | marketing text and `optedIn` is not exactly `true` |
| `missing-opt-out` | marketing text with no standalone word "STOP" |
| `unknown-timezone` | marketing text and `timeZone` is missing or not a valid IANA name |
| `quiet-hours` | marketing text outside 8:00–20:59 in the customer's local time (47 CFR 64.1200(c)(1)) |

The local hour comes from the customer's `timeZone`, not the server's UTC clock, and it follows daylight saving time. I treated exactly 21:00 as too late, to stay on the safe side.

These choices are mine. Change them if you disagree:
- **STOP blocks transactional texts too.** A customer who replied STOP gets nothing, including shipping notices. That follows CTIA's rule that STOP ends the program. If you want login codes the customer just requested to get through, it's a one-line change.
- **Transactional texts skip the consent, time-zone and quiet-hours checks.** They only need to pass the checks on input, text and opt-out.
- **A missing or invalid time zone holds marketing texts.** I don't guess a zone for a customer, so these customers get no marketing until their profile is fixed.
- **Every marketing text must contain "STOP".** CTIA only requires opt-out wording in the first message, but the function keeps nothing between calls, so it can't tell which message is first.

The function can't catch these:
- **Wrong `kind`.** It trusts the `kind` you pass. A promotion labeled `transactional` would go out at any hour.
- **Do-not-call registry and state rules.** The FCC do-not-call list and stricter state rules (Florida and Oklahoma have shorter calling hours, for example) aren't checked.
- **Texts to India and Japan.** Those countries have their own rules, which I didn't cover.
