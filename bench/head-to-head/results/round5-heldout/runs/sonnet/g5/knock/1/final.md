`bot.mjs` is written and its checks pass. I ran them with Node against a throw-away script in `/tmp`, and nothing was sent.

**Rules, in the order they are checked**
1. If `type` is not `"text"` or `"template"`, the result is `invalid_type`.
2. If `optedIn` is anything other than a literal `true`, the result is `not_opted_in`. This applies to templates too, because opt-in is required for every message we start.
3. A `template` is allowed after that, even when the 24-hour window has closed or the patient has never written to us.
4. A `text` message needs an open 24-hour customer-service window, counted from the patient's last inbound message:
   - A null `lastInboundTimestamp` gives `no_inbound_message`.
   - A timestamp that is not a digits-only string gives `invalid_timestamp`.
   - A timestamp 24 hours or more in the past gives `window_expired`. Exactly 24 hours counts as expired, which is the cautious reading.

**Timestamp handling.** Meta's webhook `timestamp` is Unix time in seconds. I parse it as seconds, not milliseconds. A millisecond-sized value, such as the seconds value times 1000, would look like a date far in the future. It is rejected as `invalid_timestamp` instead of making the window look open. I allow up to 5 minutes of clock difference between our server and Meta. A timestamp further in the future than that is also `invalid_timestamp`.

Malformed input also returns allowed false, with codes `invalid_message`, `invalid_contact` and `invalid_now`. I added these beyond what you specified.

**What I checked.** The cases I ran:
- A text sent 1 hour and 86399 seconds after the inbound message is allowed.
- A text sent at exactly 24 hours, and one sent later, are refused.
- A millisecond-sized timestamp is refused.
- A null timestamp is refused for text.
- A patient who has not opted in is refused for both text and template.
- A template is allowed with a null or very old timestamp.
- A non-numeric timestamp and an unknown type are refused.

I did not save the check script in the repo. It is at `/tmp/bot-check.mjs` if you want to move it into a test folder.
