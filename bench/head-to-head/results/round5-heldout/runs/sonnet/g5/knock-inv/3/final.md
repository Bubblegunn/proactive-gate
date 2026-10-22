`bot.mjs` is written and exports `decideWhatsApp(message, now)`. A throwaway test script (in `/tmp`, not in the repo) passed all 12 cases. It covers the 24-hour boundary, templates outside the window, no opt-in, a missing inbound timestamp, a millisecond timestamp and bad input. Nothing is sent.

The skill's notification best-practices rules are generic and don't cover WhatsApp, so the rules below come from Meta's WhatsApp policy.

Checks run in this order, and each stop has its own code:
1. **`invalid_message_type`:** `type` is neither `"text"` nor `"template"`.
2. **`invalid_now`:** `now` is not a valid Date.
3. **`no_opt_in`:** `optedIn` is not exactly `true`. This applies to text and templates alike.
4. **Templates:** a template that passes the opt-in check is allowed at any time, with or without a prior inbound message.
5. **`no_inbound_message`:** a text message when `lastInboundTimestamp` is null, since the patient has never written to us.
6. **`invalid_inbound_timestamp`:** the timestamp is not a plain integer string, or is more than 5 minutes ahead of our clock.
7. **`service_window_closed`:** a text message when 24 hours or more have passed since the patient's last message.

A text message that passes all of these returns `{ allowed: true, reason: null }`.

- **Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, and the function reads it that way. A millisecond value is rejected as invalid instead of being treated as a date far in the future.
- **Exactly 24 hours:** a text message exactly 24 hours after the patient's last message is blocked. I chose the strict reading so we never send at the edge.
- **Clock skew:** a timestamp up to 5 minutes ahead of our server clock is accepted as normal skew between Meta's clock and ours. Beyond that it is invalid and the text message is blocked. The 5 minutes is my assumption, so change it if you want a different tolerance.
