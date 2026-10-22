I wrote `bot.mjs` and ran it against 11 sample messages. Every result matched what I expected. Nothing is sent, and it has no dependencies.

**Rules, checked in this order**
1. `invalid_message_type`: `type` is not `"text"` or `"template"`.
2. `invalid_now`: `now` is not a valid Date.
3. `not_opted_in`: `optedIn` is not exactly `true`. This applies to both text and template messages.
4. Template messages that pass the checks above are allowed. A template can be sent at any time, so it ignores `lastInboundTimestamp`.
5. Text messages need an inbound message from the patient within the last 24 hours:
   - `no_inbound_message`: `lastInboundTimestamp` is null.
   - `invalid_inbound_timestamp`: the value is not a string of digits, or it is more than 5 minutes in the future.
   - `outside_24h_window`: the last inbound message is 24 hours old or older.

**Timestamp handling:** Meta's webhook `timestamp` is Unix time in seconds, not milliseconds. I read it as seconds. A 13-digit milliseconds value is rejected as `invalid_inbound_timestamp`, so it can't be read as a far-future time that would keep the window open forever. The 5-minute allowance covers small differences between Meta's clock and ours.

**Test cases:** I covered a text message inside the window, one just inside, one outside, and one with a milliseconds timestamp. I also covered a null timestamp, a non-numeric timestamp, and an unknown type. Templates were tested with and without opt-in, and with and without a timestamp.

**Choices you may want to change**
- Exactly 24 hours counts as expired, which errs on the side of not sending.
- I did not add checks for template approval status or language, because the input has no data for them.
