Wrote `bot.mjs` in the work dir. It exports `decideWhatsApp(message, now)`, is synchronous, has no dependencies, and sends nothing.

**Courier skill:** It covers Courier's own product, and its WhatsApp page is about Twilio. It has nothing on Meta's Cloud API, so the rules below come from my knowledge of Meta's policy, not from a live docs check. Please confirm the window and opt-in rules against Meta's current docs before relying on them.

**Rules, checked in order:**
1. `not_opted_in`: `contact.optedIn !== true`. Applies to every type.
2. `unsupported_message_type`: type is neither `"text"` nor `"template"`.
3. Templates are allowed once opted in, regardless of when the patient last wrote.
4. Text (free-form) is allowed only inside the 24-hour customer service window:
   - `service_window_closed`: `lastInboundTimestamp` is `null`/absent, or 24 hours or more have passed since it.
   - `invalid_last_inbound_timestamp`: the value is not a string of digits, is out of safe-integer range, or is in the future relative to `now`.

**Timestamp handling:** Meta's webhook `timestamp` is Unix time in seconds, as a string. The code parses it as `Number(value) * 1000` ms. For example, `"1767272400"` is 2026-01-01T13:00:00Z.

**Choices you may want to change:**
- At exactly 24h the window is closed (`>=`). This is the conservative reading.
- A future timestamp is refused, not treated as open. This fails closed on clock skew, at the cost of blocking a send for a few seconds in that case.
- `now` must be a valid `Date`, and `message` must be an object. Otherwise the function throws `TypeError`, since that is a programming error, not a send decision.

**Verification:** I ran assertion checks (not saved to the repo) covering every rule, the 24h boundary, malformed and future timestamps, unknown types, bad `now`, and the four distinct reason codes. All passed, and `node --check` passes. The local runtime is Node 24, not 22. I used only long-standing ES features, but I did not run it on Node 22 itself.
