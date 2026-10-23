`bot.mjs` is written and its 12 tests pass (`node --test bot.test.mjs`). The tests are in `bot.test.mjs`. Nothing is sent. The function never reads the clock or a file, and the tests check that it doesn't change its arguments.

**Rule identifiers in `dropped`** (one per reason):
- `promo-no-opt-in`: a promo for a customer with `promoOptIn` not exactly `true`. Apple's App Store guideline 4.5.4 requires explicit opt-in for promotional push.
- `quiet-hours`: a promo or reminder during the customer's window, checked in their own time zone.
- `dedupe-7d`: the same `dedupeKey` was already sent in the last 7 days.
- `duplicate-in-batch`: two candidates share a `dedupeKey`, so the lower-priority one is held.
- `rate-cap-24h`: the customer already has 3 promos and reminders in the last 24 hours.
- `unknown-category`: the category isn't one of the three you listed.

**Ordering and the cap:**
- **Critical messages:** they go first, then higher `priority`. They skip quiet hours and the 3-per-24h cap, and they don't count toward it. I treated them as transactional.
- **Cap choice:** the cap is spent on the highest priority first, so a held duplicate doesn't use up a slot.

**Choices I made where your spec was silent:**
- **Dedupe covers critical messages.** I applied your 7-day rule to everything, so a second fraud alert with the same `dedupeKey` is held. If alerts can repeat for new events, give each event its own `dedupeKey`, or tell me to exempt critical from dedupe.
- **Quiet-hours edges.** The window can wrap midnight (22:00–07:00), the start is included, and the end is not. A window where `start` equals `end` is treated as empty.
- **Bad data.** An invalid `now` or a malformed `HH:MM` throws. An unparseable `sentAt` in `history` counts as "just now", so bad data can only hold messages back.

I haven't tested an invalid `timeZone` name; it should throw a `RangeError` from `Intl`. I also haven't committed anything.
