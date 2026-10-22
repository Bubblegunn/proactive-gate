I wrote `bot.mjs` with `decideWhatsApp(message, now)`. I ran it against 11 cases and all gave the expected result. Nothing was sent.

**Rules, checked in this order**
1. **Bad input:** the function returns `invalid_message` for a missing or malformed message or contact, `invalid_now` for a bad `now`, and `invalid_type` for a type other than `text` or `template`.
2. **Opt-in:** `not_opted_in` unless `optedIn` is exactly `true`. This blocks every message, including free-form replies inside the 24-hour window.
3. **Templates:** a template from an opted-in patient is always allowed, whether or not the patient has ever written to us.
4. **Free-form text:** it needs an open 24-hour service window.
   - `no_inbound_message`: the patient has never written to us.
   - `invalid_timestamp`: the timestamp is not a string of digits, or it is more than 5 minutes in the future.
   - `service_window_closed`: the last patient message is 24 hours old or older. The window counts as closed at exactly 24 hours.

**Timestamp**
- Meta's webhook `timestamp` is Unix time in seconds, so the code multiplies it by 1000 before comparing with `now`.
- A timestamp mistakenly given in milliseconds lands far in the future and is rejected as `invalid_timestamp`. It is not treated as a recent message.

**Cases I ran**

| Case | Result |
|---|---|
| Text, last message 1 hour ago | allowed |
| Text, 86,399 seconds ago | allowed |
| Text, exactly 24 hours ago | `service_window_closed` |
| Text, timestamp in milliseconds | `invalid_timestamp` |
| Text, never written to us | `no_inbound_message` |
| Text, not opted in | `not_opted_in` |
| Template, not opted in | `not_opted_in` |
| Template, opted in, no prior message | allowed |
| Template, opted in, old message | allowed |
| Text, timestamp "abc" | `invalid_timestamp` |
| Type "voice" | `invalid_type` |

I kept the test script in `/tmp/t.mjs`, outside the repo.

I chose the 5-minute future tolerance (for small clock differences between Meta and our server) and the exact-24-hour cutoff myself. Both are constants at the top of the file if you want different values.
