I wrote `bot.mjs` in the work directory. It exports `decideWhatsApp(message, now)` and has no dependencies. I ran 14 edge cases locally and nothing was sent.

The Courier skill didn't apply here. It covers Courier's own send API, and this code calls Meta's Cloud API directly. My search for Meta's current docs returned only third-party provider guides, not Meta's own pages. So the rules below come from my knowledge of Meta's documented behavior, not from a verified official source. Please check them against Meta's conversation-window and opt-in pages before relying on them.

**Rules, in order:**
1. **Bad input is rejected.** Bad clock → `invalid_clock`. Unknown type → `invalid_message_type`. Missing contact → `invalid_contact`.
2. **Opt-in is required for every type.** Not opted in → `not_opted_in`.
3. **Templates are allowed once opted in.** They are business-initiated, so the window doesn't apply.
4. **Free-form text needs an open 24-hour window.**
   - Patient never wrote to us → `no_customer_service_window`.
   - Timestamp is malformed → `invalid_inbound_timestamp`.
   - Timestamp is after `now` → `inbound_timestamp_in_future`.
   - 24 hours or more have passed → `customer_service_window_closed`.

**Timestamp handling:** Meta sends `timestamp` as Unix seconds in a string. The code requires digits only, then multiplies by 1000 to get milliseconds.

**Decisions to confirm:**
- The window is open while elapsed time is under 24 hours. At exactly 24 hours it is closed.
- A future timestamp is rejected rather than allowed. A small clock lag on our server would therefore block a message that Meta considers valid. If you expect that, I can add a tolerance.
- A millisecond-style timestamp such as `"1767272400000"` is caught by the future check and reported as `inbound_timestamp_in_future`, which is an imprecise code for that input.

**Checks run:** Open window, exactly 24h, 24h minus 1ms, closed window, never written, not opted in (text and template), templates with no or closed window, bad type, number instead of string, milliseconds, future, garbage, and bad clock. All returned the expected result.
