I wrote `bot.mjs` with `decideWhatsApp(message, now)`. It has no dependencies and sends nothing. All 15 inline checks pass.

**File:** `work/ours-g5-1/bot.mjs`

**Rules, in order:**
1. `now` is not a valid Date → `invalid_clock`
2. `contact.optedIn !== true` → `not_opted_in` (applies to templates and text)
3. `type === "template"` → allowed. Pre-approved templates are allowed outside the window.
4. `type` is neither template nor text → `unknown_message_type`
5. `lastInboundTimestamp` is null → `no_inbound_message`
6. Timestamp is not a digit-only string → `invalid_inbound_timestamp`
7. Timestamp is after `now` → `inbound_timestamp_in_future`
8. `now − last inbound ≥ 24h` → `service_window_closed`
9. Otherwise allowed, with `reason: null`

**Timestamp handling:** Meta's webhook `timestamp` is Unix time in whole seconds, as a string. The code multiplies by 1000 before comparing. Reading it as milliseconds would put every patient years in the past, and every text would be blocked.

**Choices you may want to change:**
- **Window boundary:** exactly 24h after the inbound message counts as closed.
- **Future timestamps:** blocked, not tolerated. If your server clock runs behind Meta's by a few seconds, a message sent right after a patient replies will be blocked. A small tolerance would fix that, but I did not add one.
- **Numeric timestamps:** rejected. The spec says the value is a string, so a number is treated as invalid.

I checked against the rules as I understand them from the Cloud API docs, without looking up the current policy text. Confirm the 24-hour window and the opt-in requirement against Meta's current docs before relying on them.
