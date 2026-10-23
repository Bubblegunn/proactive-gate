`bot.mjs` is written and exports `createGate()`. My checks passed, but I ran them on Node 24.13, not Node 22. The checks are in `/tmp/gate-test/test.mjs`, outside the project. I did not call Courier or send anything. The Courier skill covers the Courier API, and this gate is plain local code that runs before any send.

**What the gate does**
- **`daily-cap`:** a customer gets at most 3 promos per local day, midnight to midnight in the `timeZone` passed on that call. I checked this on a daylight-saving fall-back day in Los Angeles (25 hours long) and across the day boundary in Berlin.
- **`min-gap`:** two promos to one customer must be at least 2 hours apart. Exactly 2 hours is allowed. The gap is measured in both directions, so a `now` that goes backwards cannot slip through. If a push breaks both rules, it reports `daily-cap`.
- **Security alerts:** these are always allowed. They get an id but do not count toward the promo cap or gap.
- **Allowed requests:** a promo is recorded as sent the moment `request` allows it, because you send right away.
- **`cancel(id)`:** this removes that promo from the customer's count, so a push that never left doesn't use up a slot. Cancelling an unknown, already cancelled, security, or expired id does nothing.
- **Memory:** promo records older than 72 hours are dropped on later promo requests. Customers who stop receiving promos keep an empty entry until their next promo request.

**Choices I made that you didn't specify**
- **Invalid input:** bad input is refused instead of throwing, so one bad call can't crash the service. The `rule` values are `invalid-category`, `invalid-time`, `invalid-user` and `invalid-time-zone`. The time, user and time zone checks apply to promos only. A security alert is allowed even when its `timeZone` or `userId` is bad.
- **Time zone changes:** the day is worked out with the time zone on the current call. If a customer's `timeZone` changes, their earlier promos are re-counted in the new zone.

**Checks I ran**
- The 3-per-day cap, the 2-hour gap and its exact boundary, and the local-midnight rollover.
- The daylight-saving day.
- `cancel` freeing a slot, and repeat or unknown cancels.
- Security alerts staying out of the promo count.
- Customers being counted separately.
- Invalid input being refused.
