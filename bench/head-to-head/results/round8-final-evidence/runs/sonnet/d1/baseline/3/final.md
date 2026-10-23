`bot.mjs` is written, and my 36 checks pass. They cover the 8:00 and 21:00 edges, a fall-back DST day, Tokyo and Kolkata, missing or bad time zones, STOP, and odd input such as `null`, a throwing getter and an invalid `now`. The test script is in `/tmp/gt/t.mjs`, outside the repo. Nothing is sent.

**Rules, checked in this order (the first one that fails is reported):**

| `rule` | Held when |
|---|---|
| `invalid-input` | `now`, `user`, `message`, or `user.sms` is missing or malformed, `kind` is unknown, or `text` is empty. |
| `opted-out` | `optedOutAt` is anything other than null or missing. An unparseable value also counts as opted out. |
| `no-consent` | Marketing, and `optedIn` is not exactly `true`. |
| `no-opt-out-notice` | Marketing text has no "Reply STOP" style instruction (STOP, END, CANCEL, UNSUBSCRIBE or QUIT). |
| `unknown-time-zone` | Marketing, and the profile zone is null, not a real IANA name, or a placeholder such as "UTC", "GMT", "Etc/…" or "+05:00". |
| `quiet-hours` | Marketing, and the customer's local time is before 08:00 or at/after 21:00 (47 CFR 64.1200(c)(1)). |
| `check-error` | Any unexpected failure. The function holds the text rather than throwing. |

Transactional texts skip the consent, notice and quiet-hours rules. Only invalid input and an opt-out hold them.

**Decisions for you to check:**
- **STOP also blocks transactional texts.** Under 64.1200(a)(10) a revocation covers further messages from you, and a STOP reply is clear. The cost is that a customer who texted STOP won't get login codes or shipping notices by SMS. To let those through, move the `return allow()` for transactional above the `opted-out` check. That is a legal call for you or your counsel.
- **Unknown time zone holds marketing.** I can't tell which zone a customer is in without one. A zone that is valid but wrong, such as a Chicago customer saved as "America/New_York", can't be detected.
- **Other rules not covered.** Florida and Oklahoma have stricter hours, 8am to 8pm, and the function doesn't know the customer's state. India restricts promotional texts to 9am to 9pm and has a DND registry. Japan requires opt-in. If you want stricter windows, they are a small change.
- **Mixed texts.** A "transactional" text that also contains a promotion counts as marketing under the FCC. The function trusts `kind` and does not inspect the text.
- **Timing.** The check uses the `now` you pass. A text queued to send a few minutes later could land after 21:00.
