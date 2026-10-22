`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I ran 11 cases in a throw-away script, and all gave the expected result. Nothing was sent. I did not open the skill's rule files, so none of the rules below come from the Knock skill. They come from my knowledge of WhatsApp's policy and the Cloud API docs.

**Rules, checked in this order**

| Reason code | Stops the message when |
|---|---|
| `invalid_message` | `message` or `message.contact` is missing. |
| `invalid_now` | `now` is not a valid Date. |
| `invalid_message_type` | `type` is neither `"text"` nor `"template"`. |
| `not_opted_in` | `optedIn` is not exactly `true`. This applies to templates and text. |
| `invalid_timestamp` | `lastInboundTimestamp` is not a string of epoch seconds, or is more than 5 minutes in the future. |
| `outside_service_window` | A text message has no inbound timestamp, or the last inbound message was 24 hours or more ago. |

- **Opt-in:** it is checked first, so a patient who never agreed is never contacted by either message type.
- **Templates:** a template needs only opt-in. It can be sent at any time, including to a patient who has never written to us.
- **Free-form text:** it is allowed only inside the 24-hour customer service window. That window opens when the patient last messaged us.
- **Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, as a string. The code reads it that way.
- **Milliseconds:** a value in milliseconds fails the format check and returns `invalid_timestamp`. It does not get treated as a date far in the future.

**Decisions to confirm**
- **Window boundary:** exactly 24 hours counts as closed. 86,399 seconds is allowed and 86,400 is denied. I chose the stricter reading.
- **Never-written patients:** they get `outside_service_window`, the same code as an expired window. I treated both as one rule, since both mean the window is closed. If you want a separate code for patients who never wrote, it is a one-line change.
- **Clock skew:** a timestamp up to 5 minutes ahead of our clock is accepted. Anything further ahead is `invalid_timestamp`.

I did not add the test script to the repo. It is in `/tmp/t.mjs` if you want it kept.
