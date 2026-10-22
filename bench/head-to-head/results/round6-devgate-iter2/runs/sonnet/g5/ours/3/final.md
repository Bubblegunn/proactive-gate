I wrote `bot.mjs`, and a quick Node 22 script confirmed it decides correctly in the 11 cases I ran. Nothing was sent.

**Rules, checked in this order**
1. **Bad input:** a missing message or contact, or an invalid `now`, returns `invalid_message` or `invalid_clock`.
2. **Message type:** anything other than `text` or `template` returns `unknown_message_type`.
3. **Opt-in:** `optedIn` must be exactly `true`. Otherwise the result is `no_opt_in`, for text and templates alike.
4. **Templates:** these are allowed at any time once the patient has opted in, including when they have never written to us or wrote long ago.
5. **Free-form text:** this is allowed only inside the 24-hour customer service window, which starts at the patient's last inbound message. The three denial codes are:
   - `no_inbound_message`: `lastInboundTimestamp` is null, so the patient has never written to us.
   - `invalid_inbound_timestamp`: the value is not a string of digits, or it is more than 5 minutes ahead of our clock.
   - `outside_24h_window`: 24 hours or more have passed.

**Timestamp handling**
- Meta's webhook `timestamp` is Unix time in seconds, so the code compares it with `now` in seconds.
- A millisecond value (13 digits) is rejected as `invalid_inbound_timestamp` instead of being read as a date far in the future.
- At exactly 24 hours the window counts as closed, which is the cautious choice.

**What I ran**
- Text inside the window is allowed, at 23h59 as well, and refused at 24h and 1 second.
- Text with a null timestamp, a millisecond timestamp or a garbage timestamp is refused, each with its own code.
- Text without opt-in is refused.
- Templates are allowed with a null or very old timestamp, and refused without opt-in.
- An unknown type is refused.

**Not covered**
- The function doesn't look at template category (marketing or utility). Meta applies some separate rules to marketing templates, such as per-user frequency limits. Those would need extra data on the message.
