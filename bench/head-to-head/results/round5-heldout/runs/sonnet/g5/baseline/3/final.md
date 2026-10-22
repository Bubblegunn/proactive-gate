I wrote `bot.mjs` with `decideWhatsApp(message, now)`. I tested it with a throwaway script that sends nothing, and every case passed. One check first looked like a failure, but my expected value was wrong: `1767272400` is 2026-01-01T13:00Z, only 11 hours before the `now` I had picked. I re-ran it with `now` just before and just after the 24-hour mark, and it returned allowed and not allowed as it should.

**Rules, checked in this order:**
1. **No opt-in:** the message is blocked with `not_opted_in`. Only `optedIn === true` passes, so a missing or odd value also blocks. This applies to every message, including replies inside the 24-hour window.
2. **Template:** allowed whenever the patient is opted in, whether or not they have ever written to us.
3. **Any other `type`:** blocked with `unknown_message_type`.
4. **Text, patient has never written:** blocked with `no_inbound_message`.
5. **Text, timestamp unusable:** blocked with `invalid_timestamp`. That covers a non-numeric value, an invalid `now`, and a timestamp more than 5 minutes ahead of our clock.
6. **Text, more than 24 hours since the last inbound message:** blocked with `outside_24h_window`. Exactly 24 hours counts as outside, so the gate errs on the side of not sending.
7. **Otherwise:** `{ allowed: true, reason: null }`.

**Timestamp:** Meta's webhook `timestamp` is Unix time in seconds, so the code multiplies by 1000 before comparing with `now`. One test confirms that a millisecond-style value fails instead of being read as recent.

**Decision for you:** the 5-minute allowance for our clock running slightly behind Meta's is my own choice. The constant is `FUTURE_SKEW_MS` if you want a different value.
