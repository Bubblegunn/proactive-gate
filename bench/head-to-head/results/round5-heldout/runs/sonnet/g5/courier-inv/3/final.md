`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I checked it with a throw-away script in `/tmp` that covers each rule and the window edges, and all of those checks passed. Nothing was sent.

Rules, in the order they are checked:
1. **No opt-in:** if `optedIn` is not exactly `true`, the message is stopped with `not_opted_in`. This applies to every message type.
2. **Template:** an opted-in patient can always get a template, whether or not they have ever written to us.
3. **Text:** free-form text is allowed only inside the 24-hour service window.
4. **Other types:** any type other than `text` or `template` gets `unsupported_message_type`.
5. **Missing contact:** a message with no contact object gets `invalid_message`.

Reason codes for text that is stopped:
- `no_inbound_message`: the patient has never written to us.
- `service_window_closed`: 24 hours or more have passed since their last message.
- `invalid_timestamp`: the value is not a string of digits, or it is more than 5 minutes in the future.
- `invalid_clock`: `now` is not a valid Date.

Meta's webhook `timestamp` is Unix time in seconds, so I compare it with `now` in seconds. A millisecond value would look like it is far in the future and gets `invalid_timestamp`.

- **Window edge:** exactly 24 hours counts as closed, to stay on the safe side. 23 hours 59 minutes 59 seconds is still allowed.
- **Clock skew:** a timestamp up to 5 minutes ahead of our clock is accepted as skew. That tolerance is my choice, not something Meta defines.
- **Skill is Twilio-based:** the courier skill's WhatsApp guide is written for sending through Twilio, not Meta's Cloud API directly. I used it only for the opt-in rule and the 24-hour window. I did not check these rules against Meta's own documentation, so confirm them there.
