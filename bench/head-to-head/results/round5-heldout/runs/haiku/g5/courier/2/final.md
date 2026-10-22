`bot.mjs` is written at `work/courier-g5-2/bot.mjs`. All 16 edge-case checks pass. Nothing was sent, and I did not commit.

**Rules, in order:**
1. **`not_opted_in`**: `optedIn` is not exactly `true`. Applies to every message type.
2. **Template**: allowed at any time after opt-in, including outside the 24-hour window and for patients who never wrote to us.
3. **Other types**: anything other than `"text"` or `"template"` returns `unsupported_message_type`.
4. **Text, no window**: `lastInboundTimestamp` is `null`, so the window never opened. Returns `customer_service_window_closed`.
5. **Text, timestamp check**: must be a string of digits. Meta sends Unix time in **seconds**, so the code multiplies by 1000. A number, a millisecond value, or non-numeric text returns `invalid_inbound_timestamp`.
6. **Text, future timestamp or invalid `now`**: returns `invalid_inbound_timestamp`.
7. **Text, window check**: allowed while elapsed time is under 24 hours. At or after 24 hours it returns `customer_service_window_closed`.

**Choices to review:**
- Exactly 24 hours counts as closed. The window is treated as open only for strictly less than 24 hours.
- Never-wrote-to-us and expired windows share one code, `customer_service_window_closed`, because they are the same rule. Split them if you want separate codes.
- Future timestamps are rejected rather than tolerated. A server clock running behind Meta's would block some valid text sends. Say if you want a skew allowance.
- I worked from my knowledge of Meta's policy and did not run a live web check against the current docs.

**Testing:** the checks ran on Node v24.13.0, not Node 22. The file uses only plain ES module syntax with no dependencies, so it should run unchanged on Node 22. The check script lives in `/tmp/bot-check/`, outside the repo.
