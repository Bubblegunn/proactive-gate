`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I ran 11 cases against it and all passed. The checks were a throw-away script in `/tmp`, not part of the repo. Nothing was sent.

The gate applies these rules in this order:

1. **Opt-in:** `contact.optedIn` must be exactly `true` for every message, text or template. Otherwise it returns `opt_in_missing`.
2. **Templates:** a template from an opted-in patient is allowed at any time, even if the patient never wrote to us.
3. **Free-form text:** allowed only inside the 24-hour window after the patient's last message. A null `lastInboundTimestamp` returns `no_inbound_message`.
4. **Timestamp unit:** I read Meta's webhook `timestamp` as Unix time in **seconds**, so the code multiplies it by 1000 before comparing with `now`. A value that looks like milliseconds fails as `invalid_timestamp`.
5. **Window edge:** a message is allowed while its age is under 24 hours. At exactly 24 hours it returns `outside_24h_window`.

The other reason codes are `invalid_message`, `invalid_type`, `invalid_contact` and `invalid_timestamp`. A timestamp that isn't a digit string, or is more than 5 minutes in the future (to allow for clock skew), also returns `invalid_timestamp`. Each rule has its own code. `reason` is `null` when `allowed` is true.

If `now` isn't a valid `Date`, the function throws a `TypeError` instead of returning a result, because that is a bug in our code rather than a message problem.

I only read the opt-in and window rules from memory of Meta's policy and did not re-check the current documentation. Please confirm the 24-hour window and the template-anytime rule against Meta's docs before this goes live.
