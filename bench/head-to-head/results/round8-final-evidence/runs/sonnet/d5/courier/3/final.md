`bot.mjs` is written and its 11 tests in `bot.test.mjs` pass (`node --test bot.test.mjs`). The function is pure: it reads no clock or file and doesn't change its arguments. Nothing is sent.

**Rule ids in `dropped`** (one per reason)
- `unknown-category`: the category isn't `promo`, `reminder` or `critical`.
- `promo-no-opt-in`: a promo for a customer with `promoOptIn` false. Apple guideline 4.5.4 allows promotional push only with explicit opt-in, and the function can't tell in-app from push, so it holds all such promos.
- `quiet-hours`: a reminder or promo during the customer's quiet hours, judged in their `timeZone`.
- `dedupe-7d`: the `dedupeKey` was already sent within the last 7 days.
- `dedupe-same-batch`: a higher-priority candidate in this batch has the same `dedupeKey` and wins.
- `rate-limit-24h`: the customer already has 3 reminders and promos in the rolling 24 hours, counting those picked in this batch.

If a candidate fails several checks, the first one in the list above is the id it gets. Candidates are processed best first, with ties kept in input order, and `send` is in that order.

**Choices I made where the policy was silent**
- **Critical messages:** they skip the quiet-hours, opt-in and 24-hour cap checks and don't use up cap slots. They still go through the 7-day dedupe, because the policy says the same key must not repeat. If a repeat fraud alert should get through, give it a new `dedupeKey` or tell me to exempt `critical` from dedupe.
- **Quiet hours:** a window can cross midnight (`22:00` to `07:00`). The start time is inside the window and the end time is not. If start equals end, it is treated as no window.
- **Day boundaries:** a message sent exactly 24 hours ago no longer counts toward the cap, and one sent exactly 7 days ago no longer blocks its key.
- **Dropped candidates:** a candidate that is held doesn't reserve its `dedupeKey` or a cap slot.
- **Bad input:** an invalid `now`, an invalid `sentAt`, a malformed quiet-hours time or a bad time zone throws instead of guessing. History entries dated in the future count as recent.
