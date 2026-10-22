Wrote `bot.mjs` in the working directory. It exports `decideWhatsApp(message, now)`, is synchronous, has no dependencies, and sends nothing. All checks pass.

**Rules, in order (first failure wins):**

| Check | Code when blocked |
|---|---|
| Malformed `message` or `contact` | `invalid_message` |
| `type` is not `text` or `template` | `unsupported_message_type` |
| `optedIn` is not exactly `true` (missing counts as not opted in) | `not_opted_in` |
| `template` (after opt-in) | allowed, no window needed |
| `text`, patient never wrote to us (`null`) | `no_inbound_message` |
| `text`, timestamp not a usable Meta value | `invalid_inbound_timestamp` |
| `text`, 24 h or more since last inbound | `customer_service_window_closed` |

Otherwise it returns `{ allowed: true, reason: null }`.

**Choices I made that you may want to check:**
- **Timestamp units:** Meta's webhook `timestamp` is Unix seconds as a string, so the code multiplies by 1000 before building a Date. `"1767272400000"` (milliseconds) is rejected as invalid, not read as a date in the far future.
- **Strict string check:** a numeric `1767272400` is rejected as `invalid_inbound_timestamp`, because your spec says the value arrives as a string.
- **Window boundary:** the window is open for less than 24 h and closed at exactly 24 h. I chose the conservative side.
- **Clock skew:** an inbound timestamp up to 5 minutes ahead of your server clock is accepted as "just now". More than that is `invalid_inbound_timestamp`. This keeps a reply sent seconds after a patient message from being blocked by a small clock difference.
- **Bad `now`:** a non-Date or invalid Date throws a `TypeError`, since that is a caller bug and not a message decision.

**Checks run:** I ran the function with Node 24.13 (the file uses only Node 22 features). Every case in the table gave the expected result. The boundary cases behaved as above: 23 h 59 min 59 s is allowed, 24 h minus 1 ms is allowed, and exactly 24 h is blocked. Skew of 2 s is allowed, 10 min is blocked, and the millisecond and numeric timestamp cases are blocked. I did not add a test file to the project, and I did not commit anything.
