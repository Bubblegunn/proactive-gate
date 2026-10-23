`bot.mjs` is written and exports `createGate()`. My check script passes, and it never sends anything. I ran it on Node 24.13 here, not Node 22.

**Rules and identifiers**
- **`daily-cap`:** a promo is denied if the customer already has 3 allowed promos on the same calendar day in their own time zone. The day runs midnight to midnight local time.
- **`min-gap`:** a promo is denied if it falls less than 2 hours from any earlier allowed promo. Exactly 2 hours is allowed.
- **Order:** `daily-cap` is checked before `min-gap`.
- **Security alerts:** these are always allowed. They are not counted toward the promo limits and are not blocked by them. I treated them as exempt because a login alert should not wait on marketing policy.

**Other behaviour**
- **Recording:** an allowed promo is recorded immediately, because permission and sending are one step. Denied requests are not recorded.
- **`cancel(id)`:** this removes the record, so the cancelled push no longer uses up the daily cap or the 2-hour gap. Cancelling an unknown id or the same id twice does nothing.
- **Extra denial rules I added:**
  - `invalid-time-zone`: an unknown time zone is denied for promos.
  - `invalid-time`: an invalid `now` is denied.
  - `unknown-category`: any category other than "promo" or "security" is denied.
- **Time:** the gate never reads the clock. Time zones go through `Intl.DateTimeFormat`, which handles DST.
- **Memory:** promo records older than 48 hours are dropped as each customer's next request arrives.

**What the check covers**
- The cap, and the gap boundary at exactly 2 hours.
- Local midnight versus UTC for Los Angeles, and the same instant falling on different days in Berlin.
- The New York 23-hour spring-forward day.
- `cancel` freeing both the cap and the gap.
- Customers being independent of each other.
- Security alerts not counting toward the promo cap.
- Bad time zone and category.

The check script is at `/tmp/gate-check/check.mjs`, outside the repo.
