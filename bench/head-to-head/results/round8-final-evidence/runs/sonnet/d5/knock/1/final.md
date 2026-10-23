`bot.mjs` is written and exports `planSends`. I also added `bot.test.mjs`, and all 10 tests pass with `node --test bot.test.mjs`. The function doesn't read the clock or any file, and the tests confirm it leaves its arguments unchanged. Nothing is sent.

**How a candidate is held.** Each held candidate is checked in this order, and the first rule that applies is its `rule`:

| `rule` | Held because |
|---|---|
| `unknown-category` | The category isn't promo, reminder or critical. |
| `promo-no-opt-in` | It's a promo and `promoOptIn` isn't `true`. Apple's push-notification guideline (4.5.4) requires opt-in for promotional pushes. |
| `quiet-hours` | It's a promo or reminder, and it's now inside the customer's quiet hours in their own time zone. |
| `dedupe-7d` | The same `dedupeKey` was sent in the last 7 days. |
| `dedupe-in-batch` | Another candidate in this batch has the same `dedupeKey` and a higher priority. Only the best one goes. |
| `rolling-24h-cap` | The customer has already hit 3 promos and reminders in the last 24 hours. Higher priority gets the remaining slots. |

Dropped entries come back in the same order as the input. Ties in priority keep input order.

**Calls I made where your policy was silent.** Change any of these if you disagree:
- **Critical messages** skip opt-in, quiet hours and the 24-hour cap, and they don't count toward the cap. Fraud alerts have to go through.
- **Dedupe applies to critical messages too**, since your 7-day rule is general. A repeat fraud alert with the same `dedupeKey` within a week is held.
- **Quiet-hours edges.** A window like `22:00` to `07:00` wraps past midnight. The start time is inside the window and the end time is outside it. If start equals end, I treat it as no quiet hours.
- **Rolling windows.** An entry exactly 24 hours old no longer counts toward the cap, and one exactly 7 days old no longer blocks the same `dedupeKey`.
- **Bad input.** An invalid time zone, `HH:MM` value or `sentAt` throws instead of guessing.
