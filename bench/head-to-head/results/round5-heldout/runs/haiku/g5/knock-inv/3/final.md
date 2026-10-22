`bot.mjs` is written at `bot.mjs` in the working directory. All 15 decision checks pass on Node v24.13.0. Nothing was sent, and nothing is committed.

**What it does**, checked in this order, first failure wins:

1. `type` must be `"text"` or `"template"`. Otherwise `invalid_message_type`.
2. `now` must be a valid Date. Otherwise `invalid_clock`.
3. `contact.optedIn` must be exactly `true`. Otherwise `not_opted_in`. This applies to templates too.
4. Templates are then allowed. They can go out with no prior inbound message, or after the 24-hour window has closed.
5. Text needs an open customer service window:
   - No inbound message on record: `no_inbound_message`.
   - Timestamp unparseable, or more than 5 minutes in the future: `invalid_inbound_timestamp`.
   - 24 hours or more since the inbound message: `service_window_closed`.
   - Otherwise allowed.

**The timestamp:** Meta's webhook `timestamp` is Unix seconds as a string. The code accepts only digits, multiplies by 1000, and never passes the raw value to `new Date()`. A millisecond string or a JS number is rejected rather than guessed at.

**Choices I made that you should confirm:**
- The window is open when elapsed time is under 24 hours (`23:59:59` allowed, exactly `24:00:00` blocked).
- A 5-minute tolerance for an inbound timestamp slightly ahead of our clock. Anything further ahead fails closed.
- Only the 24-hour customer service window is modelled. The 72-hour window that opens after a click-to-WhatsApp ad is not, because the data has no field for it. Those patients would be blocked from free-form text until they write again.
- Template category rules (marketing vs. utility), template quality, and per-user marketing frequency caps are not modelled. The data doesn't include them.

**Limits of the check:** I did not look up Meta's current docs. The window and template rules are from my own knowledge, and they should be checked against the Cloud API documentation before this goes live. The tests were ad-hoc, in a temp file I deleted. Nothing was added to the repo.
