`bot.mjs` is written, and a throwaway check script I ran passed. The script is at `/tmp/gate-check/check.mjs`, outside the repo. Nothing was sent.

**What `createGate()` does**
- **Promos:**
  - A promo is denied with `daily-cap` when the customer already has 3 promos on the same local calendar day. The day is midnight to midnight in the `timeZone` passed to that request, so the DST/UTC-offset handling comes from `Intl`.
  - It is denied with `min-gap` when the customer has another promo less than 2 hours before or after `now`. Exactly 2 hours is allowed.
  - When both rules apply, `daily-cap` is reported.
  - An allowed promo is recorded immediately, because the caller sends right away.
- **Security alerts:** these are always allowed and never counted against promo limits. An alert is not blocked by a bad time zone either.
- **`cancel(id)`:** removes that promo from the counts, which frees both the daily slot and the gap. An unknown id, a repeated cancel, or a security id does nothing.
- **Invalid input:** these get a denial with their own rule. They are `invalid-category`, `invalid-time-zone`, and `invalid-time` (`now` is not a valid Date).
- **Rule identifiers:** `daily-cap`, `min-gap`, `invalid-category`, `invalid-time-zone` and `invalid-time`.
- **Memory:** promo records older than 48 hours are dropped, so memory stays bounded.
- **Clock:** the gate never reads the system clock.

**What the check covered**
- The Los Angeles midnight boundary in July: 06:59Z is still the previous day, 07:00Z is the new day.
- The same instants in Berlin, where the day boundary falls at a different time.
- Exact 2-hour gap edges.
- Cancel freeing capacity.
- Users being independent of each other.
- Security alerts not being limited or counted.
- An invalid time zone.

I did not use any Courier API calls, since this is pure gating logic with no sending. The Courier skill's guide on frequency caps (`throttling.md`) was not read.
