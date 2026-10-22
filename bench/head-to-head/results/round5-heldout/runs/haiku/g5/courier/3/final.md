I wrote `bot.mjs` in the working directory and it exports `decideWhatsApp(message, now)`. All 13 inline checks pass. Nothing was sent, and I did not commit.

**Rules, in the order they are checked:**
1. `not_opted_in`: anything other than `optedIn === true` is rejected. This covers both text and template.
2. Template: allowed for any opted-in contact, whether or not the patient has written to us recently.
3. `unknown_message_type`: for any type other than `"text"` or `"template"`.
4. Text, `lastInboundTimestamp` null: `no_inbound_message`.
5. Text, timestamp not a digit string: `invalid_inbound_timestamp`. This fails closed, so a malformed value never opens the window.
6. Text, 24 hours or more since the last inbound: `customer_service_window_closed`. The window is open for less than 24 hours and closed at exactly 24 hours.

**Timestamp handling:** Meta's webhook `timestamp` is Unix epoch seconds as a string, so the code multiplies by 1000 before comparing. Reading it as milliseconds would make every patient look like they had just written to us.

**Choices you may want to change:**
- If `lastInboundTimestamp` is later than the server clock, the window is treated as open. Small clock skew is normal, but a large gap would be worth alerting on.
- An invalid `now` throws a `TypeError` instead of returning a reason, because that is a bug in our server, not a patient-data problem.

**Not verified:** I wrote the rules from my knowledge of Meta's policy (24-hour customer service window, opt-in for business-initiated messages, templates outside the window, epoch-seconds timestamps). I did not fetch the current Meta docs, so check the window and opt-in rules against them before relying on this in production.
