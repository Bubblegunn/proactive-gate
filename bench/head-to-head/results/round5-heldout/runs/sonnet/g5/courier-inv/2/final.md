I wrote `bot.mjs`, and my checks pass. I ran a short script covering each rule and the 24-hour boundary. It sent nothing, since the function makes no API calls.

The WhatsApp reference in the Courier skill describes Twilio, not Meta's Cloud API, so I wrote the rules from Meta's policy as you described it.

**Rules, checked in this order:**
1. **Opt-in:** anything other than `optedIn === true` is blocked with `not_opted_in`. This applies to both message types.
2. **Templates:** an opted-in patient can always be sent a template, even if they have never written to us.
3. **Text, no history:** if `lastInboundTimestamp` is null, the message is blocked with `no_inbound_message`.
4. **Text, window closed:** if the patient's last message is 24 hours old or older, it is blocked with `outside_24h_window`. At 86,399 seconds it is allowed.

**Timestamp:** Meta's webhook `timestamp` is Unix time in seconds, as a string. The code parses it that way. A milliseconds value, such as `"1767272400000"`, looks far in the future, so it is blocked instead of being treated as a recent message.

**Bad input is blocked, not allowed:**
- **Timestamp:** a non-numeric string, or one more than 5 minutes ahead of the server clock, gives `invalid_inbound_timestamp`. I allowed 5 minutes of lead because Meta's clock and yours can differ slightly. That figure is my choice, so change it if you want.
- **Other inputs:** an unknown `type`, a missing contact, a missing message or an invalid `now` each get their own code (`invalid_message_type`, `invalid_contact`, `invalid_message`, `invalid_now`).

I did not commit anything.
