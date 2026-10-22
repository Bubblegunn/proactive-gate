I wrote `bot.mjs` in the working directory. `decideWhatsApp(message, now)` is a synchronous, dependency-free ES module that returns `{ allowed, reason }`. My 20 behavior checks all pass. I ran them from a temp file outside the repo and deleted it afterward. Nothing was sent and nothing was committed.

**Rules, in the order they're checked:**

| Case | Result | `reason` |
|---|---|---|
| `type` is neither `text` nor `template` | deny | `unknown_message_type` |
| `optedIn` is not exactly `true` | deny | `not_opted_in` |
| `template`, opted in | allow | `null` |
| `text`, patient never wrote to us (`null` or missing) | deny | `outside_customer_service_window` |
| `text`, `lastInboundTimestamp` malformed | deny | `invalid_last_inbound_timestamp` |
| `text`, inbound more than 5 min in the future | deny | `invalid_last_inbound_timestamp` |
| `text`, 24 h or more since inbound | deny | `outside_customer_service_window` |
| `text`, under 24 h since inbound | allow | `null` |

**Decisions you may want to check:**

- **Timestamp unit:** Meta's `timestamp` is a string of Unix seconds, so the code does `Number(ts) * 1000`. A millisecond value (`"1767272400000"`) is rejected as a unit mix-up, since it would land about 55,000 years in the future.
- **24-hour boundary:** the window is open for elapsed time strictly under 24 h. At exactly 24 h it is closed.
- **Clock skew:** an inbound timestamp up to 5 minutes ahead of our clock is accepted. Larger leads are rejected as invalid. The 5-minute value is my choice, not something Meta defines.
- **Never-contacted patients:** text is denied with the same code as an expired window, because both are the same rule: no open window. Templates are still allowed if the patient opted in.
- **Invalid `now`:** a non-`Date` or invalid `Date` throws a `TypeError`. That is a programming error, not patient data.
- **Templates:** the function trusts `type: "template"` to mean a pre-approved, correctly categorized template. It cannot check Meta approval or template category.

I only ran it on Node 24, since Node 22 isn't installed here. The code uses only long-standing ES2015+ features, so I expect it to run on Node 22 unchanged, but I haven't verified that.
