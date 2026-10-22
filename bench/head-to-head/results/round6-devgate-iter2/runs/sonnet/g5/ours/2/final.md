`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I ran it on ten sample messages and every one gave the expected result. It sends nothing. I did not commit it.

Rules, checked in this order, each with its own reason code:
1. **`invalid_message_type`:** `type` is neither `"text"` nor `"template"`.
2. **`no_opt_in`:** `optedIn` is not exactly `true`. This applies to both types, so nobody who hasn't agreed is ever contacted.
3. **Templates:** a template from an opted-in patient is allowed at any time, with or without a prior inbound message.
4. **`no_inbound_message`:** a free-form text where `lastInboundTimestamp` is null, because the patient has never written to us.
5. **`invalid_inbound_timestamp`:** the timestamp is not a string of digits, or is more than 5 minutes in the future (clock skew allowance).
6. **`outside_service_window`:** a free-form text sent 24 hours or more after the patient's last inbound message.
7. **`invalid_clock`:** `now` is not a valid Date.

A free-form text inside the 24-hour window is allowed.

**Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, not milliseconds. The code divides `now` by 1000 to match. A millisecond-style value like `"1767272400000"` would be about 55,000 years in the future, so it is rejected as `invalid_inbound_timestamp` instead of being treated as inside the window.

**Window edge:** I treat exactly 24 hours as already closed, so the gate errs on the side of blocking.

**Marketing templates:** `optedIn` is a single flag. If you want a stricter rule for marketing templates, such as a separate marketing opt-in, the contact data would need a second field.

My test script is at `/tmp/t.mjs`, outside the repo.
