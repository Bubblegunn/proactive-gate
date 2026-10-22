`bot.mjs` is written and passes 15 checks. Nothing was sent and nothing was committed.

**Rules, in the order they are checked:**
1. **Not opted in** (`not_opted_in`): `contact.optedIn` must be exactly `true`. This applies to both text and template messages.
2. **Template** → allowed. Pre-approved templates may be sent outside the 24-hour window.
3. **Anything other than `text` or `template`** → `unsupported_message_type`.
4. **Text, patient never wrote to us** (`lastInboundTimestamp` is null) → `no_inbound_message`.
5. **Text, timestamp not a plain digit string** → `invalid_inbound_timestamp`. Meta sends `timestamp` as a string of Unix epoch seconds, so the value is multiplied by 1000 and checked as a string of digits.
6. **Text, 24 hours or more since the last inbound** → `service_window_closed`. Free-form text is allowed only inside the 24-hour customer service window, which the patient's last inbound message opens. Exactly 24:00:00 is already closed.

Otherwise the result is `{ allowed: true, reason: null }`. A missing or invalid `message` returns `invalid_message`, and an invalid `now` throws a `TypeError`.

**Checks I ran:** these cover the 24-hour boundary to the millisecond, both template cases, opt-in on both types, missing and malformed timestamps, unknown types, null input, and an invalid `now`. My first run had one failure, which came from a wrong assumption in my test, not the function. I had assumed `1767272400` is 11:00 UTC, but it is 13:00 UTC. I corrected the test and all checks pass.

**One judgment call:** if a stored inbound timestamp is later than `now` (server clock skew), the window is treated as open. Tell me if you would rather that fail closed.
