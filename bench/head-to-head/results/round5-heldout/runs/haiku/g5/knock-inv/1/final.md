`bot.mjs` is written and passes my checks. Nothing was sent.

File: `work/knock-inv-g5-1/bot.mjs`. It exports `decideWhatsApp(message, now)`, has no dependencies, and runs under Node 24 here, so Node 22 should work too.

Rules, checked in this order:

1. **`not_opted_in`**: `optedIn !== true`. This applies to every message type.
2. **`unknown_message_type`**: type is neither `"text"` nor `"template"`.
3. **Template**: allowed at any time, because pre-approved templates may start conversations.
4. **`no_customer_message`**: free-form text and the patient has never written to us.
5. **`invalid_inbound_timestamp`**: the timestamp is not a digit string, or it lies more than 5 minutes in the future. The future check catches a value in milliseconds, which would otherwise look like a timestamp far ahead of now.
6. **`service_window_closed`**: free-form text and 24 hours or more have passed since the patient's last message.
7. **Allowed**: free-form text inside the 24-hour window.

The Meta timestamp is Unix seconds as a string, so I multiply by 1000 before comparing.

Choices you may want to change:
- At exactly 24 hours the window counts as closed.
- A 5-minute clock-skew tolerance for timestamps ahead of our clock.
- A numeric timestamp (not a string) is rejected, since the contract says string.

Checks: I ran assertions covering the window boundary, the millisecond-unit case, opt-out, template behaviour, unknown types, and invalid dates. They all pass, and `node --check` is clean. I didn't load the Knock skill's rule files in detail, since they cover copy and general system design rather than WhatsApp policy. The Meta rules come from my own knowledge, not a fresh read of the current Cloud API docs, so check the 24-hour window and timestamp unit against Meta's docs before production.
