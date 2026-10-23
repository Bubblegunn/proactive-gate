`bot.mjs` is written and passes my checks. It exports `checkSend({ user, message, now })`. It sends nothing, keeps nothing between calls, and never reads the system clock. I ran it on 14 cases plus a call with no arguments and one with `null`. All behaved as listed below, and none threw.

**Rules, checked in this order**
1. **`invalid-time`**: `now` is not a valid Date.
2. **`invalid-input`**: `user` or `message` is missing or not an object.
3. **Transactional messages are allowed.** Any `kind` other than `"transactional"` counts as marketing. Transactional skips every rule below, so it goes out even after STOP.
4. **`opted-out`**: `sms.optedOutAt` has any value, even one that isn't a valid date. This check runs before the consent check.
5. **`no-consent`**: `sms.optedIn` is not exactly `true`, or `sms` is missing.
6. **`invalid-time-zone`**: `timeZone` is null, empty or not a real IANA name. I don't guess a zone for the customer.
7. **`outside-calling-hours`**: the customer's local time is outside 08:00 to before 21:00. That is the FCC window in 47 CFR 64.1200. 08:00 is allowed and 21:00 is not, and DST is handled. It uses each customer's own zone, so India and Japan follow the same window.
8. **`internal-error`**: anything unexpected. The function holds the text.

Allowed texts return `{ allowed: true, rule: "" }`.

**Checked:** a marketing text at 10:00 Chicago time is allowed. I also checked the edges at 07:59, 08:00, 20:59 and 21:00, and a Tokyo customer. The hold rules each fire as listed above, and a transactional text at night with no zone and an opt-out is allowed.

**Your decisions**
- **Transactional after STOP:** a login code or shipping notice still goes to a customer who replied STOP to marketing. That is the common reading of the rules, but it is a call for you or your counsel. If you'd rather block everything after STOP, it's a one-line change.
- **Not enforced:** CTIA recommends marketing texts name the sender and say how to opt out ("Reply STOP to opt out"), and the first one should say how to get help. I don't block on the text, so your job should add that wording.
- **Not enforced:** some states set stricter hours. Florida, for example, stops at 20:00. The gate only applies the federal window.

The file also contains a small helper kit (time-zone and window functions) appended below `checkSend`. The kit's file-state helpers are unused. My test script is at `/tmp/t.mjs`, outside the project.
