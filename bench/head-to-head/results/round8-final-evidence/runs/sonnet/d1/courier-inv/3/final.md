`bot.mjs` is written, and my check script passes. It sends nothing and never reads the clock. The check script is `/tmp/bot-check.mjs`, outside your project. It covers the 08:00 and 21:00 edges, US daylight-saving changes, Japan, India, bad time zones and malformed input. It does not run any SMS provider.

**Rules.** The first one that applies holds the text:

| `rule` | Holds |
|---|---|
| `invalid-input` | Missing or unusable `user`, `message` or `now`, or any unexpected error. |
| `opted-out` | Any text, marketing or transactional, when `sms.optedOutAt` is set. |
| `no-consent` | Marketing text when `sms.optedIn` is not exactly `true`. |
| `no-opt-out-notice` | Marketing text with no "STOP" in it. |
| `url-shortener` | Marketing text linking through bit.ly, t.co, tinyurl and similar. |
| `no-timezone` | Marketing text when `timeZone` is missing or not a time zone the system recognizes. |
| `quiet-hours` | Marketing text when the customer's local time is before 08:00 or at/after 21:00. |

**Choices you may want to change:**
- **Time of day.** I read 47 CFR 64.1200(c)(1) as "no marketing before 8 a.m. or after 9 p.m. at the customer's location". I hold from exactly 21:00 to be safe.
- **Unknown or wrong time zone.** I hold marketing instead of guessing, because your servers run in UTC and a guess could text someone at night. A time zone that is valid but wrong for the customer cannot be detected.
- **Unknown `kind`.** Anything other than exactly `"transactional"` is treated as marketing.
- **Transactional texts.** They skip the time-of-day window and the marketing-consent check. They are still held after STOP, since the carrier would block them anyway.
- **Bad `optedOutAt`.** Any value other than `null` or `undefined`, including an unparseable or future timestamp, counts as opted out.
- **Opt-out notice and shorteners.** The check can't tell whether this is a customer's first text, so every marketing text must contain "STOP". The CTIA guidance on opt-out wording and public shorteners is my reading of it, and I did not check it against the document.
- **India.** The TRAI rules (India's telecom regulator) for promotional texts are stricter: 09:00–21:00 plus a Do-Not-Disturb registry. Japan has its own opt-in rules for promotional messages. I applied only the US window, as you asked. Tell me if you want a stricter window for India.
