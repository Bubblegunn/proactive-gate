`bot.mjs` is written and exports `planSends`. It reads no clock or file and does not change its arguments. I also added `bot.test.mjs`, which has 8 tests; `node --test bot.test.mjs` passes all of them. Nothing is sent.

**Rules and their identifiers in `dropped`:**
- `promo-not-opted-in`: a promo goes out only if `promoOptIn` is true. This follows App Store Guideline 4.5.4, which bars promotional push without opt-in.
- `quiet-hours`: the window is checked against local time in `user.timeZone`. It can cross midnight, and the end time is exclusive, so a 07:00 end means 07:00 is allowed.
- `dedupe-7-days`: the same `dedupeKey` was sent less than 7 days ago.
- `dedupe-in-batch`: two candidates in this batch share a key. The higher-priority one goes out and the other is dropped.
- `cap-3-per-24h`: reminders and promos together are limited to 3 in a rolling 24 hours. History counts toward the limit, and a message sent exactly 24 hours ago does not count. Higher priority wins when there isn't room for all.
- `invalid-candidate`: unknown category or a priority that is not a number.
- `invalid-user-config`: quiet hours or time zone can't be parsed.

**Critical messages** skip quiet hours and the 24-hour cap, and they don't use up cap slots. They do still go through the 7-day dedupe, as your policy says. Each distinct fraud or security alert therefore needs its own `dedupeKey`, or a repeat within 7 days is dropped.

**Ordering:** `send` is sorted by priority, highest first. Ties go to critical, then reminder, then promo, then input order. A low-priority critical message can therefore sort after a high-priority promo. Say so if you want critical always first. `dropped` lists candidates in input order.

**Choices I made where the spec was silent:**
- If `quietHours.start` equals `end`, the window is treated as empty.
- An unparseable `sentAt` in `history` is treated as "just now", so it blocks and counts toward the cap.
- A non-critical message with bad quiet-hours or time-zone settings is held rather than sent.
- An invalid `now` throws a `TypeError`.

I did not check the quiet-hours logic across a daylight-saving change.
