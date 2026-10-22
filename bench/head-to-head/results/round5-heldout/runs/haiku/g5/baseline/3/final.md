I wrote `bot.mjs` in the working directory. It exports `decideWhatsApp(message, now)`, is synchronous, has no dependencies, and sends nothing. My check script passed all assertions, and the module loads and exports `decideWhatsApp`. I did not commit.

**Rules, in order:**
1. **Opt-in:** if `contact.optedIn !== true`, block with `not_opted_in`. This applies to templates and text.
2. **Template:** allowed. Meta lets a business send approved templates to an opted-in contact at any time, inside or outside the 24-hour window.
3. **Other types:** anything other than `text` or `template` is blocked with `unsupported_message_type`.
4. **Text, never inbound:** `lastInboundTimestamp` is null or missing, so block with `no_inbound_message`.
5. **Text, timestamp check:** the value must be a string of digits, otherwise `invalid_inbound_timestamp`.
6. **Text, window:** Meta's timestamp is Unix seconds, so it is multiplied by 1000 before comparison. If the window has run 24 hours or more, block with `customer_window_closed`. Otherwise allow.

**Choices you may want to change:**
- **Window boundary:** exactly 24 hours counts as closed. This is the conservative reading.
- **Clock skew:** a timestamp more than 5 minutes ahead of your server clock is rejected as `invalid_inbound_timestamp`. This catches a millisecond value read as seconds, which would otherwise keep the window open for about 30,000 years. Small skew is tolerated.
- **Bad `now`:** a non-Date or invalid Date throws a `TypeError`. It does not return a reason code.
