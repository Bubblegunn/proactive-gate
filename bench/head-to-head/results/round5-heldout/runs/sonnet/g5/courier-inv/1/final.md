`bot.mjs` is written and exports `decideWhatsApp(message, now)`. I ran it against 11 cases and each gave the result below. Nothing was sent. I didn't use Courier's API, since this only gates calls to Meta. I also didn't check the 24-hour and opt-in rules against Meta's docs. I applied them from what I already know of the Cloud API.

**Rules, in the order they are checked**
1. If `type` isn't `"text"` or `"template"`, it returns `invalid_message_type`. A missing message or contact gives `invalid_message` or `invalid_contact`.
2. If `optedIn` isn't exactly `true`, it returns `not_opted_in`. This applies to both types, so a patient who hasn't agreed is never contacted, even inside the 24-hour window.
3. A `"template"` message from an opted-in patient is always allowed. Meta permits approved templates outside the 24-hour window.
4. A `"text"` message needs the 24-hour customer service window to be open, which means the patient's last inbound message was less than 24 hours ago.
   - `null` gives `no_inbound_message`.
   - A timestamp that isn't a digit string, or is more than 5 minutes in the future, gives `invalid_inbound_timestamp`.
   - An age of 24 hours or more gives `outside_24h_window`. The boundary is closed: at exactly 24 hours it blocks.
   - An invalid `now` Date gives `invalid_now`.

**Timestamp**
- Meta's webhook `timestamp` is Unix time in seconds (UTC), not milliseconds, so the code compares it to `now.getTime() / 1000`.
- If someone passes a millisecond value, it lands far in the future and is rejected as `invalid_inbound_timestamp`. It does not silently open the window.

**Checks I ran** (with `now` at 2026-01-02 12:00 UTC)

| Case | Result |
|---|---|
| text, last inbound 1 hour ago | allowed |
| text, 23h59m ago | allowed |
| text, exactly 24h ago | `outside_24h_window` |
| text, millisecond-style timestamp | `invalid_inbound_timestamp` |
| text, `null` | `no_inbound_message` |
| text, garbage timestamp | `invalid_inbound_timestamp` |
| template, `null` or very old timestamp | allowed |
| not opted in, text or template | `not_opted_in` |
| unknown type | `invalid_message_type` |

I chose to fail closed on malformed input. A bad timestamp or type blocks the message instead of guessing.
