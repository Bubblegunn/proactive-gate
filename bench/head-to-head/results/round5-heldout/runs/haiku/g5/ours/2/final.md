I wrote `bot.mjs` in the work directory and checked it. It is an ES module with no dependencies, and it exports `decideWhatsApp(message, now)`. Nothing is sent. I did not commit it.

Checks run against it: 17 behaviour cases plus the timestamp boundary from your example all pass, and `node --check` passes.

**How the rules are ordered (first failing rule wins):**

| Code | When |
|---|---|
| `invalid_message` | message or contact is missing or not an object |
| `unknown_message_type` | `type` is neither `"text"` nor `"template"` |
| `not_opted_in` | `optedIn` is not exactly `true` (applies to both types) |
| `invalid_now` | `now` is not a valid Date |
| `invalid_inbound_timestamp` | timestamp is not digits only, is not a safe integer after conversion, or is more than 5 minutes in the future |
| `outside_service_window` | text message, and the last inbound is null or 24 h or more before `now` |

Allowed results return `{ allowed: true, reason: null }`.

**Decisions I made that you may want to change:**
- **Timestamp:** Meta sends Unix time in whole seconds as a string, so the function converts it with `Number(ts) * 1000`. A millisecond value would land far in the future, so anything more than 5 minutes ahead of `now` is rejected rather than treated as an open window.
- **Window edge:** the window is open while elapsed time is under 24 h. At exactly 24 h it is closed.
- **Templates:** allowed outside the window whenever the patient has opted in. Text messages never bypass the window.
- **Fail-closed:** malformed input returns a denial with a code instead of throwing.

The test script is at `/tmp/bot-check/check.mjs`, outside the work directory. The `package.json` in the work directory still lists a `proactive-gate` dependency. I left it alone because `bot.mjs` does not import it.
