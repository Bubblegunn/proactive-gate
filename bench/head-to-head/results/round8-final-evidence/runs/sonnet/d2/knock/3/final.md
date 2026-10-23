`bot.mjs` is written. It exports `createGate()` with `request` and `cancel`. My check script passed, covering the cases below.

**What the gate does**
- **Promos:** denied if another promo to that customer is less than 2 hours away from `now`, and denied if the customer already has 3 promos on that local calendar day. The 2-hour check runs first, so a request that breaks both rules reports `min-gap`.
- **Security:** always allowed. These pushes don't count toward the promo limits.
- **Day boundaries:** a promo's local day is worked out with `Intl.DateTimeFormat` in the `timeZone` passed on the current request. Daylight-saving days of 23 or 25 hours are handled correctly.
- **Cancel:** removes the send, so it stops counting toward both the daily cap and the 2-hour gap. Cancelling an unknown or already-cancelled id does nothing.
- **Memory:** promo records older than 72 hours are dropped as requests come in. Nothing reads the system clock.

**Rule identifiers**
- `min-gap`: another promo is less than 2 hours away.
- `daily-cap`: 3 promos already sent that local day.
- `invalid-category`, `invalid-time`, `invalid-user` and `invalid-time-zone`: bad input. A bad request is denied, not sent. A security push ignores `timeZone` and `userId`.

**What the check covered**
- The 2-hour gap, at 1 second under and exactly at 2 hours.
- The daily cap, and the reset at local midnight.
- The same moment landing on different days in Los Angeles and Berlin.
- Cancel freeing both a gap and a daily slot.
- Security pushes not counting toward promo limits.
- Users being independent of each other.
- The 25-hour day on 1 Nov 2026 in Los Angeles.
- Bad time zone and bad category.

The check script is `/tmp/bot-check.mjs`, outside the project.

If a customer changes time zone during a day, their earlier promos are re-counted against the new zone's calendar day. I chose that so the cap always follows the zone you pass in with the current request.
