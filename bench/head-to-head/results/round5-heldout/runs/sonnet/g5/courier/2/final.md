I wrote `bot.mjs`. It exports `decideWhatsApp(message, now)` as a synchronous function with no dependencies. I ran it against 11 cases with a throw-away script in `/tmp` (not saved in the repo), and all gave the expected result. Nothing is sent anywhere.

**Rules, checked in this order**

| Check | Result |
|---|---|
| `now` is not a valid `Date` | `invalid_now` |
| `message` is missing or not an object | `invalid_message` |
| `type` is neither `"text"` nor `"template"` | `invalid_message_type` |
| `contact` is missing or not an object | `invalid_contact` |
| `optedIn` is not exactly `true` | `not_opted_in` |
| Template and opted in | allowed, with no time limit |
| Text and `lastInboundTimestamp` is null | `no_inbound_message` |
| Text and the timestamp isn't a plain whole number | `invalid_timestamp` |
| Text and the timestamp is more than 5 minutes in the future | `invalid_timestamp` |
| Text and the last inbound message was 24 hours or more ago | `outside_24h_window` |
| Text and the last inbound message was less than 24 hours ago | allowed |

- **Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, and the code reads it that way. A millisecond value such as `1767272400000` is rejected as `invalid_timestamp`. It is not silently converted, because that would hide a bug upstream.
- **Window boundary:** exactly 24 hours counts as closed. One second less is still allowed.
- **Clock skew:** a timestamp up to 5 minutes ahead of our clock is accepted, to allow for small clock differences with Meta. Anything further ahead is rejected.
- **Fail closed:** any malformed input is blocked.
- **Opt-in first:** it is checked before the window, so an opted-out patient never gets a message, whatever the type.

**Tests:** the cases I ran covered these:
- text sent 1 hour after the patient's message
- text 1 second inside the window
- text exactly at 24 hours
- text with no inbound message
- a template with no inbound message
- a template far outside the window
- text and template sends to a patient who has not opted in
- a millisecond timestamp
- a non-numeric timestamp
- an unknown message type

**Not covered by this function:** whether the template is approved, and Meta's per-recipient marketing limits and quality-based throttling. Those depend on state or on Meta's own checks, not on the data you pass in.
