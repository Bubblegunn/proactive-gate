I wrote `bot.mjs` and it passes my checks. It is not committed.

**File:** `work/knock-g5-3/bot.mjs`. It exports `decideWhatsApp(message, now)`, has no dependencies, and sends nothing.

**Rules, checked in order:**
1. **Opt-in** (all message types): `contact.optedIn` must be exactly `true`. Otherwise `not_opted_in`.
2. **Template:** allowed after opt-in, at any time. Templates are the only thing Meta lets a business send outside the 24-hour window.
3. **Any other type** that is not `"text"`: `unsupported_message_type`.
4. **Text (free-form):** allowed only within 24 hours of the patient's last inbound message.
   - No inbound message ever: `no_inbound_message`.
   - Timestamp is not a string of digits: `invalid_inbound_timestamp`.
   - Inbound is later than `now`: `inbound_timestamp_in_future`.
   - 24 hours or more elapsed: `service_window_closed`.

**Timestamp handling:** Meta's webhook `timestamp` is Unix time in seconds, as a string. The code converts it with `× 1000` before any date math. Reading it as milliseconds would make every window look expired.

**Checks run:** I ran about 20 assertions with `node`. They cover template-outside-window, opt-in on both types, the 24-hour edge (one ms before allowed, exactly 24 h blocked), a null inbound, malformed and numeric timestamps, a future timestamp, an unknown type, and an invalid `now` (which throws). All passed. The sandbox runs Node 24.13, not 22. The code uses only basic language features, so I expect it to behave the same on Node 22, but I did not run it there.

**Choices you may want to change:**
- Exactly 24 hours counts as closed. Meta's wording is "within 24 hours", so this is the conservative reading.
- A future timestamp fails closed. If your server clock runs behind Meta's, legitimate replies could be blocked during the skew. A small tolerance would fix that if you see it.
- The function does not check template names, categories, or approval status. Those belong in your template registry, not in this decision.
- Opt-in is a single boolean. It does not distinguish marketing from utility consent. Tell me if your consent records need that split.
