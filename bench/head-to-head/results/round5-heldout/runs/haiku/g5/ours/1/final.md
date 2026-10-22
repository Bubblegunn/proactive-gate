I wrote `bot.mjs` in the working directory. It exports `decideWhatsApp(message, now)`, uses no dependencies, and sends nothing. All 15 ad hoc checks pass, including the 24-hour boundary, the seconds-not-milliseconds timestamp, and each reason code. I ran them from a temporary script and deleted it, so no test file was added. Local Node is v24.13.0, not 22; the code uses only standard features.

**Rules, in order (first failure wins):**

| Check | Reason code |
|---|---|
| `optedIn !== true` | `not_opted_in` |
| type is neither `text` nor `template` | `unsupported_message_type` |
| text, `lastInboundTimestamp` is null | `no_inbound_message` |
| text, timestamp is not a digit-only string | `invalid_inbound_timestamp` |
| text, inbound time is later than `now` | `inbound_timestamp_in_future` |
| text, 24 hours or more since inbound | `customer_service_window_closed` |

Otherwise the result is `{ allowed: true, reason: null }`. Templates pass for any opted-in patient, inside or outside the window, and their timestamp is never read.

**Choices you should check:**

- **Timestamp:** Meta's `timestamp` is a string of Unix seconds, so it is multiplied by 1000 before use. A millisecond value is therefore read as a time far in the future and blocked, not sent.
- **Window boundary:** the window is open while elapsed time is under 24 hours. At exactly 24 hours it is closed.
- **Future inbound time:** I block rather than allow. Small clock skew can trigger this for a message received seconds ago. If that causes problems, the fix is a small tolerance, not allowing all future timestamps.
- **Invalid `now`:** throws a `TypeError`, since that is a caller bug. Malformed webhook timestamps return a reason code instead, so the webhook handler does not crash.

**Not covered:** marketing-template category rules and template approval status. The function does not know a template's category, so it cannot apply Meta's extra limits on marketing sends. Those need a separate check if you send marketing templates.

I did not commit anything.
