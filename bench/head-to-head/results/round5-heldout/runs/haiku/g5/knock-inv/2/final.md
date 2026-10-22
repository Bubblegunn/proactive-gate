Wrote `bot.mjs` at `work/knock-inv-g5-2/bot.mjs`. It exports `decideWhatsApp(message, now)`, has no dependencies, and sends nothing. All behavior checks pass.

**Rules, in check order:**
1. **Not opted in** → `not_opted_in`. Applies to every message type.
2. **Template** → allowed. Pre-approved templates can go out any time after opt-in.
3. **Other type** (not `text` or `template`) → `unsupported_message_type`.
4. **Text, never heard from patient** (`lastInboundTimestamp` null) → `no_customer_service_window`.
5. **Text, timestamp not a 10-digit string of seconds** → `invalid_inbound_timestamp`. This covers numbers, millisecond values, and junk.
6. **Text, timestamp later than `now`** (clock skew) → `invalid_inbound_timestamp`. We can't prove the window is open, so we refuse.
7. **Text, 24 hours or more since last inbound** → `customer_service_window_closed`. Exactly 24h counts as closed.
8. Otherwise → `{ allowed: true, reason: null }`.

**Timestamp reading:** Meta's `timestamp` is Unix time in seconds, delivered as a string. The code multiplies by 1000 before comparing with `now`. Passing it straight to `new Date()` would put every message in 1970 and make the window look closed. Meta's status webhook reference shows a 10-digit seconds string (`"1750030073"`), which matches.

**Verification:** I ran about 25 assertions from a scratch file in `/tmp` (outside the repo). They cover opt-in gating, template sends with no window, text window open, boundary, and closed, the ms-vs-seconds trap, bad input, and distinct reason codes. The first run failed because my test helper computed the base time wrong (`1767272400` is 13:00 UTC, not 11:00). I fixed the test; `bot.mjs` was unchanged. I also confirmed the module exports only `decideWhatsApp`.

**Sources and gaps:**
- The 24-hour window and template-only-outside-window rule come from third-party provider docs, such as [Rasayel's service window page](https://docs.rasayel.io/whatsapp-service-window) and [360dialog's messaging overview](https://docs.360dialog.com/docs/messaging/overview). I did not fetch Meta's own text, so confirm the window rule against [Meta's Cloud API docs](https://developers.facebook.com/documentation/business-messaging/whatsapp).
- The seconds-as-string format is supported by [Meta's status webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status). I did not find the inbound `messages` field itself. Check it on a real webhook payload before relying on it.
- The skill's guidance is general notification advice. It did not change the rules above, which follow your spec and WhatsApp policy.

I did not commit anything.
