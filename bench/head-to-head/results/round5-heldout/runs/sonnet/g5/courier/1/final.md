I wrote `bot.mjs` with `decideWhatsApp(message, now)`, and it passed a quick run of 10 cases in Node. Nothing was sent. I ran those cases ad hoc, so there is no test file in the repo.

**Rules, checked in this order**
1. If `type` is not `"text"` or `"template"`, it returns `invalid_message_type`.
2. If `contact.optedIn` is not exactly `true`, it returns `not_opted_in`. This applies to both message types.
3. A template message is then allowed at any time, even if the patient has never written to us.
4. A free-form text message is allowed only inside the 24-hour service window that starts at the patient's last inbound message.
   - If `lastInboundTimestamp` is null, or 24 hours or more have passed, it returns `outside_service_window`.
   - If the timestamp is not a string of digits, or is more than 5 minutes in the future, it returns `invalid_timestamp`.

**Timestamp handling**
- Meta's webhook `timestamp` is Unix time in seconds, not milliseconds. The code reads it that way.
- A timestamp in milliseconds would land far in the future, so it is rejected as `invalid_timestamp` instead of being treated as a fresh window.
- I allowed 5 minutes of clock difference between Meta's clock and ours. That number is my choice, not something from Meta's documentation.
- At exactly 24 hours the window counts as closed. That is the cautious choice, and it is also my own decision.

**Checks I ran**
- Text 1 hour after the last inbound message is allowed.
- Text 23 hours 59 minutes 59 seconds after the last inbound message is allowed.
- Text at exactly 24 hours is blocked with `outside_service_window`.
- Text with a timestamp in milliseconds is blocked with `invalid_timestamp`.
- Text with a null timestamp is blocked with `outside_service_window`.
- A template with a null timestamp is allowed.
- A template with an old timestamp is allowed.
- A message with `optedIn: false` is blocked with `not_opted_in`.
- An unknown message type is blocked with `invalid_message_type`.
- The timestamp `"abc"` is blocked with `invalid_timestamp`.

I used one code, `outside_service_window`, for both "never wrote to us" and "window expired", because both break the same rule. I can split them if you want separate codes.
