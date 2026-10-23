`bot.mjs` is written and exports `createGate()`. The checks I ran against it passed. Nothing was sent.

**Rules**
- **Promo, daily cap:** at most 3 per customer per local day. The day comes from the `timeZone` on each request, so midnight is the customer's own midnight. A promo counts toward the day it was sent on, and the day is worked out in the time zone of the current request. If a customer's zone changes, the cap still follows the new zone. Denials return `daily-cap`.
- **Promo, spacing:** a promo is denied if any earlier promo to the same customer is less than 2 hours away. Exactly 2 hours is allowed. Denials return `min-gap`.
- **Security:** always allowed and never counted against the promo limits. Marketing's cap shouldn't block a login alert.
- **Recording and cancel:** an allowed request is recorded immediately. A denied one records nothing. `cancel(id)` removes the record, which frees the slot and the 2-hour gap. Cancelling the same id twice, or an unknown id, does nothing.
- **Bad input:** a promo request fails closed with one of `invalid-time-zone`, `invalid-time`, `invalid-user` or `unknown-category`. An unrecognised category is denied too.
- **Memory:** promo records older than 72 hours, measured from the latest `now` seen, are dropped.

**What I tested**, in `/tmp/t.mjs`, which isn't part of the repo:
- The cap, the spacing and the exact 2-hour boundary.
- Security alerts passing after the promo cap was reached.
- Reset at the customer's local midnight (Los Angeles), and a Berlin case where two promos fall on opposite sides of midnight but the spacing rule still blocks the second.
- A cancel freeing a slot.

I did not test the daylight-saving days where a local day is 23 or 25 hours long. The code has no special handling for them because it counts by local calendar date.

The skill's docs didn't change the design. They only confirmed that security alerts are transactional.
