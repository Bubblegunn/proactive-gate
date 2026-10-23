`bot.mjs` is written and exports `createGate()` with `request` and `cancel`. My test script passes, and nothing is actually sent. The script is `/tmp/gt/test.mjs`, outside the repo, so it isn't saved with the project.

**What the gate does**
- **Security:** a security push is always allowed, gets an id, and is never counted against the promo limits.
- **Promo, 3 per day:** a promo is refused with `daily-cap` once the customer already has 3 promos on that calendar day in their own time zone.
- **Promo, 2 hours apart:** a promo is refused with `min-gap` if it falls within 2 hours of another promo to the same customer. Exactly 2 hours apart is allowed. If both rules apply, `min-gap` is reported.
- **Cancel:** `cancel(id)` removes that promo from the count, so the slot and the gap are freed. Cancelling an unknown or already-cancelled id does nothing.
- **Bad input:** these are refused (they are not allowed through) with `invalid-category`, `invalid-time`, `invalid-user` and `invalid-time-zone`.
- **Invalid time zone:** a promo with an invalid time zone is refused rather than sent, because the gate can't tell which day it belongs to. A security push doesn't need the time zone, so it still goes through.
- **Memory:** promo history older than 3 days is dropped, so memory use stays bounded.

**What the test covered**
- The 3-per-day limit, the exactly-2-hours case, and the day rolling over at midnight in Los Angeles.
- The Berlin day boundary, and that users are counted separately.
- Security pushes not affecting promos, and the invalid time zone.
- `cancel` freeing a promo slot.

Two things to keep in mind:
- If a customer's stored time zone changes, their earlier promos are re-counted against the new time zone.
- The history is kept in memory, so it resets if the process restarts.
