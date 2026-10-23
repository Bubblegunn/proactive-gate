`bot.mjs` is written and exports `createGate()`. I ran a test script covering the rules below, and it passes. I kept the script in `/tmp/gate-test/test.mjs`, outside your repo.

**Promos**
- **Daily cap:** the gate refuses a 4th promo in the same local day with rule `daily-cap`. The local day is midnight to midnight in the `timeZone` you pass on that request.
- **Gap:** the gate refuses a promo less than 2 hours from another promo to the same customer with rule `min-gap`. Exactly 2 hours is allowed.
- **Both rules broken:** you get `daily-cap`.
- **Allowed:** an allowed promo is recorded immediately, so a second request right after it counts it.

**Security**
- Security pushes are always allowed and get an id.
- They don't count toward the promo cap or the gap.

**Cancel**
- `cancel(id)` removes that promo, so it frees both its daily-cap slot and its gap.
- An unknown or already-cancelled id does nothing.

**Invalid input**
- Bad input to a promo request returns a denial instead of throwing. The rule is `unknown-category`, `invalid-time` or `invalid-time-zone`.
- A security request never checks the time zone, so a bad one can't block it.

**Tested**
- Gap boundary at 1h59m59s versus exactly 2h.
- The 3-per-day cap and the reset at local midnight in Los Angeles.
- Berlin and Los Angeles each get their own day boundary, and customers don't affect each other.
- The 25-hour local day on 1 Nov 2026, when daylight saving ends in Los Angeles.
- Security pushes don't count toward the promo limits.
- Cancel frees the slot, and a repeated or unknown cancel does nothing.

Records older than 72 hours are dropped as requests come in, so memory stays bounded. A request with a `now` more than 72 hours in the past no longer sees those older promos.
