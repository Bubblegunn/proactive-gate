`bot.mjs` is written and exports `planSends`. I also wrote `bot.test.mjs`, and `node --test` passes all 9 tests. It reads no clock or file, doesn't change its arguments, and sends nothing.

**Rules, and the `rule` id in `dropped`:**
- **`unknown-category`:** the category isn't promo, reminder or critical.
- **`promo-no-opt-in`:** a promo for a customer without `promoOptIn`. Apple guideline 4.5.4 allows promotional push only with explicit opt-in.
- **`quiet-hours`:** the customer's local time, from `timeZone` including DST, falls inside their window. The window can span midnight, and the end time is exclusive.
- **`quiet-hours-invalid`:** the window is malformed, so non-critical messages are held rather than sent.
- **`dedupe-7d`:** the same `dedupeKey` was sent within the last 7 days.
- **`dedupe-same-batch`:** a higher-priority candidate with the same key was already chosen.
- **`frequency-cap-24h`:** the 3-per-rolling-24-hours limit for reminders and promos is used up. Slots go to the highest priority first.

Each dropped candidate gets the first rule it fails, in that order. `send` is sorted by priority, highest first, and ties keep their input order.

**Decisions to check:**
- **Critical messages bypass quiet hours, promo opt-in and the 24h cap, and don't use up cap slots.** I treated fraud and security alerts as transactional. A critical message still obeys the 7-day dedupe rule because your policy had no exception, so give repeat alerts distinct keys.
- **Sort order uses `priority` only.** A high-priority promo can be listed ahead of a low-priority critical message.
- **`quietHours` with `start` equal to `end`** counts as no window.
- **Bad `now`, bad `timeZone` or unparseable `sentAt`** throws instead of guessing. Because of that, one bad history row stops the whole run, including critical sends.
- **A non-finite `priority`** sorts last.
