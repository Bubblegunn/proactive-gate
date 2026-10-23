`bot.mjs` is written. I also added `bot.test.mjs`. All 10 tests pass with `node --test bot.test.mjs` on Node 24, which is what's installed here. I haven't run them on Node 22. The function doesn't read the clock or any file, and a test confirms it leaves frozen arguments unchanged.

**Rules.** Each candidate is checked in this order, and the first rule that fails is the one reported in `dropped`:

| Rule id | What it means |
|---|---|
| `invalid-category` | The category isn't promo, reminder or critical. |
| `invalid-priority` | The priority isn't a finite number. |
| `promo-no-opt-in` | A promo for a customer without `promoOptIn: true`. Apple's guidelines (4.5.4) require opt-in for promotional push. |
| `quiet-hours` | The current time in the customer's `timeZone` is inside their window. It handles windows that wrap midnight and DST. The start is inclusive and the end is exclusive. |
| `dedupe-7-days` | The same `dedupeKey` was already sent within 7 days. |
| `dedupe-same-batch` | A higher-priority candidate with the same key is already in `send`. |
| `daily-cap-3-per-24h` | The customer already has 3 reminders and promos in the last 24 hours, counting any chosen earlier in this call. |

`send` is ordered by priority, highest first, and ties keep input order. `dropped` follows input order.

**Decisions to confirm:**
- **Critical messages skip quiet hours, the cap and the opt-in check.** They are not counted toward the cap either. I treated fraud and security alerts as transactional. They still go through both dedupe rules, because your 7-day rule had no exception. If a repeated fraud alert must always go out, exempt critical from dedupe too.
- **`start === end` in `quietHours` means no quiet hours.** If you meant "all day", change `inQuietHours` in `bot.mjs`.
- **Bad input is handled conservatively.**
  - A history entry with an unparseable `sentAt` is treated as sent just now.
  - A malformed `quietHours` string or an invalid `now` throws.
  - An invalid `timeZone` throws only when `quietHours` is set.

If you'd rather bad input never stop a critical alert, I can change the throws into a fail-open path.
