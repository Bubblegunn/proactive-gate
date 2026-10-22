I wrote `bot.mjs` with `decideWhatsApp(message, now)`. It's synchronous and has no dependencies. I ran it on 10 sample messages, and each gave the result I expected. It doesn't send anything.

**Rules, checked in this order:**
1. **Clock:** if `now` isn't a valid `Date`, it returns `invalid_clock`.
2. **Message type:** anything other than `"text"` or `"template"` returns `invalid_message_type`.
3. **Opt-in:** if `optedIn` isn't exactly `true`, it returns `not_opted_in`. This applies to every message type and is checked before anything else, so an opted-out patient is never contacted.
4. **Templates:** an opted-in patient can always receive a template, even if they have never written to us. That's how the assistant can write first.
5. **Free-form text:** it needs a patient message inside the 24-hour customer service window.
   - A null `lastInboundTimestamp` returns `no_inbound_message`.
   - A timestamp that isn't a plain integer string returns `invalid_inbound_timestamp`.
   - A timestamp more than 5 minutes ahead of our clock also returns `invalid_inbound_timestamp`. The 5 minutes is my own allowance for clock drift, so change it if you want a different tolerance.
   - Exactly 24 hours or more since the patient's last message returns `outside_service_window`.

**Timestamp unit:** Meta's webhook `timestamp` is Unix time in seconds, not milliseconds. If a milliseconds value is passed, it looks like a date far in the future, so it is refused as `invalid_inbound_timestamp`. Text is never sent on a bad timestamp.

**What I checked:**
- Text sent 1 hour after the patient's message is allowed.
- Text at 24 hours minus 1 second is allowed.
- Text at exactly 24 hours is refused.
- A null timestamp is refused for text.
- A timestamp in milliseconds is refused.
- A non-numeric timestamp is refused.
- A non-opted-in patient is refused.
- An opted-in template with a null timestamp is allowed.
- A non-opted-in template is refused.
- An unknown message type is refused.

**Not covered:** the function doesn't check which template is being sent. Meta has its own rules for marketing templates, such as per-user frequency limits and template approval status. This function doesn't try to cover those.
