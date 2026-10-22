`bot.mjs` is written at `work/courier-inv-g5-2/bot.mjs`. It exports `decideWhatsApp(message, now)`, is synchronous, has no dependencies, and sends nothing. The skill's Courier guidance didn't apply here: this is Meta Cloud API logic, not a Courier SDK call, so I wrote it from the Cloud API rules directly.

**Rules, checked in order**

1. **`not_opted_in`**: `contact.optedIn !== true` blocks everything, text and template alike.
2. **Template**: allowed. Templates are the pre-approved messages Meta permits outside the 24-hour window.
3. **Anything other than `"text"`**: `unknown_message_type`.
4. **Free-form text** needs an open customer service window, which is 24 hours from the patient's last inbound message.
   - `lastInboundTimestamp` is `null`: `outside_service_window`. No window has ever opened.
   - Elapsed time is `≥ 24h`: `outside_service_window`. The window closes at exactly 24 hours.
   - Otherwise allowed.

**Timestamp handling**

Meta's webhook `timestamp` is Unix time in seconds, sent as a string. The function requires digits only and converts with `×1000`. It allows up to 5 minutes of clock skew into the future. Anything further ahead returns `invalid_inbound_timestamp`. That catches millisecond values, which would otherwise parse as a date far in the future and make the window look open forever.

**Codes:** `not_opted_in`, `unknown_message_type`, `outside_service_window`, `invalid_inbound_timestamp`. `null` and an expired timestamp share `outside_service_window` because they break the same rule.

**Checks run**

I ran 16 cases against the function: in-window and expired text, the exact 24-hour boundary, never-messaged contacts, the millisecond and non-string timestamp cases, clock skew, opt-out for both types, unknown type, and templates with no or expired window. All pass.

My first run had one failure. The bug was in my test, not in `bot.mjs`: `Date + number` concatenates into a string. The corrected re-check passes.

**Decisions for you to confirm**

- I treated the 5-minute future-skew tolerance as a choice of mine. Meta does not specify one.
- The opt-in check runs before the type check, so an opted-out contact with an unknown type gets `not_opted_in`.

I did not commit anything and did not call any API.
