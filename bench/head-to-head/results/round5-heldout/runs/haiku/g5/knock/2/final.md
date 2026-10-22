I wrote `bot.mjs` in the working directory and checked it with 16 cases. All pass. Nothing was sent and nothing was committed.

**Rules**
- **Opt-in** (all message types): `optedIn !== true` → `not_opted_in`.
- **Templates**: allowed at any time once opted in.
- **Text** (free-form): allowed only inside the 24-hour customer service window, which opens at the patient's last inbound message.
  - No inbound ever (`null`) → `no_customer_message`.
  - Window expired → `customer_service_window_closed`.

**Timestamp**
- `lastInboundTimestamp` is Unix epoch seconds as a decimal string. The code multiplies by 1000 before making a `Date`. Example: `"1767272400"` is 2026-01-01T13:00:00Z.
- Malformed values → `invalid_last_inbound_timestamp`. That covers non-digit strings, numbers that aren't strings, and millisecond-scale values, which land far in the future.

**Choices you may want to change**
- Exactly 24 hours after the inbound message counts as closed. The window is open while elapsed time is under 24 hours.
- An inbound timestamp later than `now` is treated as invalid data and blocks text. A few seconds of clock skew would therefore block a text. If that happens in practice, allow a small tolerance.
- A numeric (non-string) timestamp is rejected, not converted. This matches the format Meta delivers.
- Passing a non-Date `now` throws a `TypeError` rather than returning a guess.

**Verification**
- The 16 cases run from `/tmp`, outside the repo. They cover each reason code, the window boundaries, and the timestamp edge cases.
- Only Node 24 was available here. The code uses only long-standing ES features, so it should run on Node 22, but that was not tested.
