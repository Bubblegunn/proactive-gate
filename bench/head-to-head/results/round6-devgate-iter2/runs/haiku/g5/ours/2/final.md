Wrote `bot.mjs` in the working directory. It exports `decideWhatsApp(message, now)`, has no dependencies, and nothing is sent. All assertion checks passed and `node --check` is clean. The local Node is v24, not 22, but the file uses only long-standing features.

**Rule order (first failure wins):**
1. `invalid_message`: message or contact missing.
2. `invalid_message_type`: type is neither `"text"` nor `"template"`.
3. `not_opted_in`: applies to every send. Only `optedIn === true` passes.
4. Templates pass after opt-in, at any time.
5. Free-form text needs an open 24-hour customer service window:
   - `invalid_clock`: `now` is not a valid Date.
   - `customer_service_window_closed`: the patient never wrote to us, or the last inbound is 24 hours old or more.
   - `invalid_inbound_timestamp`: the timestamp is not a digit string, or lies in the future.

**Timestamp handling:** Meta sends the webhook `timestamp` as Unix seconds in a string. The code multiplies by 1000 before comparing with `now`. Treating it as milliseconds would make every window look permanently open.

**Choices you may want to change:**
- **Window edge:** exactly 24 hours after the last inbound counts as closed.
- **Future timestamps:** rejected, not tolerated. A small clock skew between Meta and your server would block a legitimate text. If you see that in practice, allow a few seconds of tolerance.
- **Strict input:** a numeric timestamp (not a string) is rejected as `invalid_inbound_timestamp`. This follows your "exactly as Meta delivers it (a string)" note.
- **Opt-in for replies:** required even inside the window, because you said the patient must agree to hear from you. Meta's own rules would not require this for a reply.
- **Templates:** the function does not check template category (marketing vs. utility) or whether the template is approved. Your message shape carries no category field, so this is out of scope here. Marketing templates still need a separate opt-in check if you distinguish them.

Checks ran from a temporary file in `/tmp`, which I removed afterwards. No test file was added to the project.
