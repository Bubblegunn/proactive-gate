I wrote `bot.mjs`, which exports `decideWhatsApp(message, now)`. I ran it through 12 sample messages and every result matched what I expected. Nothing was sent.

Checks run in this order, and the first one that fails stops the message:

| Check | Reason code |
|---|---|
| `now` is not a valid Date | `invalid_clock` |
| `message` or `contact` is missing | `invalid_message` |
| `type` is not `"text"` or `"template"` | `invalid_type` |
| `optedIn` is not exactly `true` | `not_opted_in` |
| Text message and `lastInboundTimestamp` is null | `no_inbound_message` |
| Text message and the timestamp is not a digit string (or is a number rather than a string) | `invalid_timestamp` |
| Text message and the timestamp is more than 5 minutes in the future | `invalid_timestamp` |
| Text message and the patient's last message was 24 hours or more ago | `window_expired` |

- **Templates:** a template is allowed whenever the patient has opted in. It needs no recent patient message, and the timestamp is not read.
- **Free-form text:** text is allowed only within 24 hours of the patient's last message, because that is the window Meta allows for free-form replies. Exactly 24 hours counts as expired.
- **Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, so the code multiplies it by 1000 before comparing it with `now`. A value in milliseconds comes out far in the future and is rejected as `invalid_timestamp`. It does not pass as "just now".
- **Clock skew:** timestamps up to 5 minutes ahead of our server clock are accepted, to allow for small differences between Meta's clock and ours. I chose the 5 minutes myself.
- **Bad input:** any malformed input is blocked rather than allowed.

The checks covered these cases:
- a text 1 hour, 86,399 seconds and 86,400 seconds after the patient's message;
- a text with no inbound message;
- a text with a millisecond timestamp;
- a text with a non-numeric timestamp;
- a text with a timestamp 60 seconds in the future;
- text and template messages with and without opt-in;
- a template after a long gap;
- an invalid type.

I ran these from a scratch file in `/tmp`, so no test file was added to the repo.
