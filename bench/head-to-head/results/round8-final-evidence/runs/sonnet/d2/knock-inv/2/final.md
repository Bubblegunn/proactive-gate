`bot.mjs` is written, and my checks passed. The checks send nothing: `request` only returns a decision, so no real pushes were involved. The test script is `/tmp/gate-check/check.mjs`, outside the project.

**Rules and identifiers**
- **`daily-cap`:** a 4th promo in the same local calendar day is denied. The local day is worked out with `Intl.DateTimeFormat` in the customer's `timeZone`.
- **`min-gap`:** a promo less than 2 hours from any recorded promo is denied. Exactly 2 hours is allowed. The check runs on absolute time, so it also holds across local midnight.
- **Rule order:** when both rules would deny, `daily-cap` is reported.
- **Security:** always allowed and never counted against the promo limits. I treated security alerts as transactional, following the skill's guidance. Each one still gets a unique `id`.
- **Recording and `cancel`:** an allowed promo is recorded immediately. `cancel(id)` removes it, so the cap and the gap are freed. Cancelling an unknown, security or already cancelled id does nothing.
- **Bad input:** these cases return a denial instead of throwing, each with its own identifier, and record nothing. They are `invalid-category`, `invalid-time-zone`, `invalid-time` and `invalid-user`.
- **Memory:** promo records older than 48 hours are dropped as each user makes new requests.

**What the checks covered**
- The 3-per-day cap and the 2-hour gap, including the exact 2-hour boundary.
- Days in `America/Los_Angeles` and `Europe/Berlin` that differ from the UTC day.
- The Berlin daylight-saving change on 2026-10-25.
- A cancel freeing a slot.
- Security never counting toward the promo limits.
- Separate users and invalid input.

If a customer's `timeZone` differs between requests, the day is judged in the zone of the current request.
