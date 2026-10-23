`bot.mjs` is written and its 9 tests in `bot.test.mjs` pass (`node --test bot.test.mjs`). It reads no clock or file and doesn't change its arguments. Nothing is sent.

**Rules, checked in this order (a candidate gets the first one that stops it):**

| `rule` | Meaning |
|---|---|
| `unknown-category` | Category isn't promo, reminder or critical. It fails closed. |
| `promo-no-opt-in` | A promo for a customer with `promoOptIn` false. Apple guideline 4.5.4 allows push promotions only with explicit opt-in, so I applied it to every promo. |
| `quiet-hours` | Reminders and promos inside the customer's window, read in their own time zone. Windows that cross midnight and DST both work. |
| `dedupe-sent-within-7d` | The same `dedupeKey` is in history within the last 7 days. |
| `dedupe-duplicate-in-batch` | A better candidate with the same `dedupeKey` was already chosen in this run. |
| `frequency-cap-3-per-24h` | Reminders and promos already sent in the last 24 hours, plus ones chosen in this run, would exceed 3. |

- **Critical messages** skip quiet hours and the cap, and don't count toward it. They still go through the dedupe checks.
- **Ordering:** `send` is sorted by `priority`, highest first. Ties go to critical, then reminder, then promo, then input order. `dropped` follows input order. When the cap leaves only some slots, the highest-priority candidates take them.
- **Dropped candidates:** a dropped candidate doesn't hold its `dedupeKey`, so a lower-priority duplicate can still go out.
- **Window edges:** a send exactly 24 hours or 7 days ago no longer counts.
- **Bad input:** an invalid `now`, an invalid `sentAt` or a malformed quiet-hours time throws. I chose that over quietly guessing.

Decisions for you:
- **Critical dedupe:** I applied the 7-day dedupe to critical messages too, since your policy states it without exception. If a repeated fraud alert with the same `dedupeKey` must always go out, the dedupe checks need a `!isCritical` condition.
- **`quietHours` with `start` equal to `end`:** I treat it as no quiet window, not as 24 hours. A bad setting then can't silence all reminders.
