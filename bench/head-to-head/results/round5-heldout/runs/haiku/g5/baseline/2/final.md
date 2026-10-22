I wrote `bot.mjs` in the work directory. It exports `decideWhatsApp(message, now)`, has no dependencies, and sends nothing. Six spot checks pass, and a wider set of 15 cases passed earlier, after one expectation was corrected. The check files are deleted and the repo is untouched beyond the new file. I ran it on Node v24 locally, not 22; it uses only standard ES module features.

**Rules, in order (first failure wins):**
1. **Not opted in** → `contact_not_opted_in`. Applies to every message type.
2. **Template** → allowed. Pre-approved templates may be sent business-initiated outside the 24-hour window.
3. **Anything other than `text` or `template`** → `unsupported_message_type`.
4. **Free-form text** needs an open 24-hour customer service window:
   - Patient never wrote to us (`null`) → `no_customer_service_window`.
   - Timestamp is not a digits-only string → `invalid_inbound_timestamp`.
   - Timestamp is after `now` → `inbound_timestamp_in_future`.
   - 24 hours or more since the patient's last message → `customer_service_window_closed`.
   - Otherwise → allowed.
5. **Invalid `now`** (not a valid Date) → `invalid_now`.

**Timestamp handling:** Meta's webhook `timestamp` is Unix time in seconds, as a string. The function converts it with `Number(raw) * 1000`. A millisecond value would land in the far future, so it is rejected as `inbound_timestamp_in_future`.

**Judgment calls to confirm:**
- The window is closed at exactly 24 hours (`>=`). Meta's docs describe the window as 24 hours from the last message, so the boundary is an interpretation.
- A timestamp even one second in the future is rejected. If your server clock can run behind Meta's, this will reject some real messages. Allowing a few seconds of skew would fix that.
- The function does not check whether a template is approved or which category it is. You said the templates are pre-approved, so I left that out.
