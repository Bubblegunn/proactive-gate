I wrote `bot.mjs` and ran it against sample messages. It gave the expected result every time. Nothing was sent to Meta.

`decideWhatsApp(message, now)` applies these checks in order. The first one that fails stops the message:

| Check | Result | `reason` |
|---|---|---|
| `type` is not `"text"` or `"template"` | blocked | `unsupported_message_type` |
| `message` is not an object | blocked | `invalid_message` |
| `contact` is missing | blocked | `invalid_contact` |
| `optedIn` is not exactly `true` | blocked, for text and templates | `no_opt_in` |
| `type` is `"template"` | allowed, at any time, for opted-in patients | `null` |
| Text, but `now` is not a valid Date | blocked | `invalid_clock` |
| Text, but `lastInboundTimestamp` is null | blocked | `no_inbound_message` |
| Text, but the timestamp is not a string of digits | blocked | `invalid_inbound_timestamp` |
| Text, but the timestamp is more than 5 minutes ahead of `now` | blocked | `invalid_inbound_timestamp` |
| Text, 24 hours or more since the patient's last message | blocked | `service_window_closed` |
| Text, less than 24 hours since the patient's last message | allowed | `null` |

- **Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, not milliseconds. The code reads it that way. A 13-digit millisecond value looks like a date thousands of years away, so it is blocked as invalid.
- **Free text:** Meta only allows free-form text within 24 hours of the patient's last message. I block at exactly 24 hours, so a send can't land just after the window closes.
- **Clock skew:** A timestamp up to 5 minutes ahead of `now` is allowed, to cover small differences between Meta's clock and ours.
- **Unreadable timestamp:** If the timestamp is invalid for a text message, I block it. I can't prove the window is open, and a wrong guess risks a Meta rejection.

I tested these cases:
- Patient messages 0 seconds, 1 hour and 86399 seconds ago: allowed.
- Patient messages 86400 and 90000 seconds ago: blocked.
- A timestamp 60 seconds in the future: allowed. One 1 hour in the future: blocked.
- A millisecond timestamp: blocked as invalid.
- A null timestamp: blocked for text, allowed for a template.
- Not opted in: blocked for both types.
- An unknown `type`: blocked.

I only checked opt-in and the 24-hour window. Meta also rejects messages for other reasons, such as unapproved templates or quality limits, and `bot.mjs` doesn't check those.
