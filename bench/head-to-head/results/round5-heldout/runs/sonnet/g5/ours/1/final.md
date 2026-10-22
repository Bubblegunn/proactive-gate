`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I ran a throw-away check script covering every rule below, and all of its assertions passed.

Rules are applied in this order. Each stop has its own reason code.

| Order | Condition | Result |
|---|---|---|
| 1 | `type` is not `"text"` or `"template"` | `unsupported_message_type` |
| 2 | `message` or `contact` is missing or not an object | `invalid_message` |
| 3 | `optedIn` is anything other than boolean `true` | `not_opted_in` |
| 4 | `type` is `"template"` | allowed, `reason: null` |
| 5 | `type` is `"text"` and `lastInboundTimestamp` is null | `no_inbound_message` |
| 6 | `type` is `"text"` and the timestamp is not a digit string, or is more than 5 minutes ahead of `now` | `invalid_inbound_timestamp` |
| 7 | `type` is `"text"` and the last inbound message is 24 hours or more before `now` | `customer_service_window_closed` |
| 8 | `type` is `"text"` and the last inbound message is less than 24 hours before `now` | allowed, `reason: null` |

- **Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, not milliseconds. The code compares it against `now` in seconds. A 13-digit millisecond value is rejected as `invalid_inbound_timestamp` instead of being treated as a valid time.
- **Opt-in:** A patient who hasn't opted in is blocked for templates too, not only for free-form text.
- **Templates:** They skip the timestamp check, so a malformed timestamp never blocks a template.
- **Window edge:** The window is treated as closed at exactly 24 hours (86,400 seconds).
- **Choices I made:** The 5-minute allowance for a timestamp ahead of our clock is my own value. I also made `decideWhatsApp` throw a `TypeError` if `now` isn't a valid `Date`, because a bad server clock is a bug in our code, not a patient-data problem.

I left the check script at `/tmp/bot-check.mjs`, outside the repo, and nothing is sent anywhere.
