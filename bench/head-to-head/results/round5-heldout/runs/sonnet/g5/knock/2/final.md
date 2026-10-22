`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I ran 12 checks in a throw-away script (`/tmp/bot-check.mjs`, outside the repo) and all of them pass. Nothing is sent anywhere.

**Rules, in the order they are checked**

| Rule | Reason code |
|---|---|
| `type` is not `"text"` or `"template"` | `invalid_message_type` |
| `optedIn` is not exactly `true`. This applies to templates too, so a string `"true"` is rejected. | `not_opted_in` |
| Text message and `lastInboundTimestamp` is null | `no_inbound_message` |
| Text message and the timestamp is malformed, or more than 5 minutes ahead of `now` | `invalid_inbound_timestamp` |
| `now` is not a valid Date | `invalid_now` |
| Text message and 24 hours or more have passed since the patient's last message | `window_closed` |

- **Templates:** they are allowed whenever the patient has opted in, even if the patient has never written to us. The timestamp is not looked at for templates.
- **Text messages:** they are allowed only within 24 hours of the patient's last message, which is Meta's customer service window. Exactly 24 hours is rejected.
- **Timestamp format:** Meta's webhook `timestamp` is Unix time in seconds, as a string. I multiply it by 1000 before comparing it with `now`. A value that looks like milliseconds or an ISO date is rejected rather than guessed at. Otherwise it would be read as a date thousands of years away and wrongly allow the send.
- **Clock skew:** a timestamp slightly ahead of our clock is tolerated. I picked 5 minutes myself, so change it if you want a different margin.

The checks cover:
- text just inside and exactly at the 24-hour limit;
- null, millisecond and non-numeric timestamps;
- templates with no history and with an old timestamp;
- opted-out patients;
- an unknown message type.

I did not test timestamps in the future, a missing `contact`, or an invalid `now`.
