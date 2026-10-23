`bot.mjs` is written and exports `createGate()`. I ran a test script covering the rules and edge cases below, and it passed. The script is in `/tmp/gatetest/t.mjs`, outside the repo. Nothing was sent.

**Rules and identifiers**
- **Day cap:** a promo is denied with `daily-cap` when the customer already has 3 promos on the same local calendar day. That day is midnight to midnight in the `timeZone` passed with the request.
- **Gap:** a promo is denied with `min-gap` when another promo for that customer is less than 2 hours away. Exactly 2 hours is allowed.
- **Order of checks:** if both rules apply, `daily-cap` is reported.
- **Security:** always allowed, with `rule` empty. Security pushes don't count toward the day cap or the gap.
- **Allowed sends:** each gets a unique `id` (`push-1`, `push-2`, …). A promo is recorded as soon as `request` allows it.
- **`cancel(id)`:** removes that promo, so it stops counting toward the cap and the gap. An unknown or already-cancelled id does nothing.

**Behaviour I chose where you didn't specify**
- **Bad input:** a `category` other than `promo` or `security` is denied as `unknown-category`. A bad `now` is denied as `invalid-time`, and an invalid time zone as `invalid-time-zone`. Security requests skip the time zone and date checks, so an alert is never blocked by bad data.
- **Time zone changes:** stored promos are re-evaluated in the time zone of the current request. If a customer's time zone changes, today's count follows the new one.
- **Memory:** promo records older than 3 days are dropped as new requests arrive.

**What the test covered**
- The 3-per-day cap and the 2-hour gap, including exactly 2 hours.
- Local midnight in Los Angeles and in Berlin.
- The 25-hour Berlin day on 2026-10-25, when daylight saving time ends.
- Separate customers, security pushes not using up promo slots, and cancel freeing both a cap slot and the gap.
- Bad time zone and bad date.
