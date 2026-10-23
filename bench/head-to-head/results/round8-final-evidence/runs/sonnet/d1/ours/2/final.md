`bot.mjs` is written and checked. It exports `checkSend({ user, message, now })`. It never sends anything, reads no clock, stores nothing between calls, and returns instead of throwing on bad input.

I ran 14 cases and they all behaved as intended. They covered the edges of the hours window (07:59 held, 08:00 allowed, 21:00 held), Tokyo, India, a bad zone, a null zone, a STOP record, no opt-in, a transactional text at night, and garbage input.

**Marketing texts.** They are held in this order, and the first rule that applies decides:

1. `invalid-message`: the message is missing or its text is empty.
2. `invalid-user`: the user object is missing.
3. `no-consent`: `sms` is missing, `optedOutAt` is missing, or `optedIn` is not exactly `true`.
4. `opted-out`: `optedOutAt` has any value other than `null`, including an unreadable one.
5. `invalid-time`: `now` is not a valid Date.
6. `unknown-time-zone`: the zone is missing or not a real IANA name. I don't guess a zone.
7. `outside-calling-hours`: the customer's local time is outside 08:00 to before 21:00. For `Asia/Kolkata` the window is 09:00 to before 21:00, which I used because I believe the Indian telecom regulator (TRAI) sets it that way. Please confirm that.

Any `kind` other than `"transactional"` is treated as marketing, as you defined it.

**Transactional texts.** They are allowed whenever the message text and the user object are valid. They are not held by consent, a STOP record, the hours window or the time zone. I did this because the customer asked for these texts. A malformed message or user is still held (`invalid-message`, `invalid-user`).

Anything unexpected inside the function returns `check-failed` (held).

**What it does not check**
- Whether a "transactional" text also contains a promotion. A text that mixes in a promotion should be sent as marketing. Your caller has to classify it correctly.
- That the marketing text includes "Reply STOP to opt out". The CTIA best-practices guide recommends it, but the FCC rule doesn't require it, so I left it as a recommendation.
- Stricter state rules. Florida, Oklahoma and some other states have narrower hours or extra requirements, and a flat 08:00 to 21:00 does not cover them.
- Whether `optedIn` represents written consent for marketing texts. That depends on how you collected it.
- A wrong profile time zone. A zone that is a valid name but wrong can't be detected.

I appended the helper functions from the proactive-gate skill to the end of `bot.mjs`, so it is a single self-contained file.
