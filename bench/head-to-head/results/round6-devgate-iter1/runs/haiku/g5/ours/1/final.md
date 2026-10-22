I wrote `bot.mjs` in the working directory. It exports `decideWhatsApp(message, now)`, has no dependencies, and nothing is sent. My checks passed (25 assertions, run from a temporary file I then deleted).

**Rules, in the order they are checked:**

1. **Invalid `now`** (not a valid Date) → `invalid_now`.
2. **No opt-in** (`optedIn` is not exactly `true`) → `not_opted_in`. This applies to templates too: Meta requires opt-in for every business-initiated message.
3. **Template** → allowed. Templates are allowed outside the 24-hour window.
4. **Anything other than `text` or `template`** → `unsupported_message_type`.
5. **Text, patient never wrote to us** (`lastInboundTimestamp` is `null`) → `no_inbound_message`.
6. **Text, timestamp malformed** (not a digit-only string) → `invalid_inbound_timestamp`.
7. **Text, timestamp after `now`** → `inbound_timestamp_in_future`.
8. **Text, 24 hours or more since the inbound message** → `customer_service_window_closed`.
9. Otherwise → allowed.

**Choices I made:**

- **Timestamp unit:** Meta's `timestamp` is Unix seconds as a string, so I multiply by 1000. I parse the digits myself rather than calling `Date.parse`. A millisecond-scale value such as `"1767272400000"` lands far in the future and is rejected.
- **Window edge:** the window is open for elapsed time strictly under 24 hours and closed at exactly 24 hours.
- **Future timestamps fail closed.** A small amount of clock skew between Meta and our server would block a valid text message. I chose that over opening the window on a bad value. Loosen this if you see false blocks.
- **Strict typing:** a numeric timestamp or a missing field is rejected, not coerced.

**Not covered:** Meta also limits how many marketing messages a user can receive and factors in quality ratings. Those need stored history, which you ruled out, so the function does not check them. Template category (marketing vs. utility) is also outside its inputs.
