I wrote `bot.mjs` in the work directory. It exports `decideWhatsApp(message, now)`, has no dependencies, and sends nothing. All 21 behavior checks pass; I ran them from a scratch directory and removed it afterwards. Nothing is committed.

**Rules, in the order they are checked:**
1. **Unknown `type`** → `unsupported_message_type`. Only `text` and `template` are accepted.
2. **No contact object** → `missing_contact`.
3. **`optedIn !== true`** → `not_opted_in`. This applies to every message type. Only a literal `true` counts.
4. **Template** → allowed. Pre-approved templates may be sent to an opted-in contact with or without an open window.
5. **Text, `lastInboundTimestamp` missing or malformed** → `invalid_inbound_timestamp`. Fail closed.
6. **Text, `lastInboundTimestamp` is `null`** (never wrote to us) → `outside_customer_service_window`.
7. **Text, 24 hours or more since the inbound** → `outside_customer_service_window`. Exactly 24h counts as closed.
8. **Otherwise** → allowed.

**Timestamp handling:**
- Meta's `timestamp` is Unix time in **seconds**, so the code multiplies by 1000. A millisecond value would look far in the future and wrongly keep the window open, so anything more than 5 minutes ahead of `now` is rejected.
- Only strings of digits are accepted. Numbers, decimals and missing values are rejected.
- A 1-minute-ahead timestamp is allowed, to cover clock drift between Meta and our server.

**Decisions for you to check:**
- The 5-minute skew allowance is my choice. Adjust `MAX_CLOCK_SKEW_MS` if your servers drift more or less.
- A malformed timestamp blocks only text. A template to an opted-in contact still goes through, because templates do not depend on the window.
- The policy rules come from my knowledge of the WhatsApp Business Platform (opt-in before business-initiated messages, 24-hour customer service window, templates for business-initiated messages). I did not check the current Meta docs during this session, so please confirm against them before production use.
