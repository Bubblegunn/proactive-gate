`bot.mjs` is written, and my check script passes. It sends nothing. The check script is `/tmp/bot-check.mjs`. It is outside the repo and not committed.

**How it works**
- **Promo cap:** a promo is denied with `daily-cap` once the customer already has 3 promos on the same local calendar day. The day is computed from the customer's `timeZone`, and daylight-saving days are handled.
- **Spacing:** a promo is denied with `min-gap` if another promo to that customer is less than 2 hours away. Exactly 2 hours is allowed. If both rules apply, `daily-cap` is reported.
- **Security alerts:** these are always allowed and get an `id`. They never count toward the promo limits, and they are allowed even if the time zone is invalid.
- **Recording:** an allowed promo is recorded inside `request`, so the caller can send right away.
- **`cancel(id)`:** removes that promo from the customer's record, which frees both the daily slot and the 2-hour gap. Cancelling an unknown or already-cancelled id does nothing.
- **Bad input:** a promo with an invalid `now` is denied with `invalid-time`. An invalid time zone gives `invalid-time-zone`, and any category other than "promo" or "security" gives `unknown-category`.

**What the check covers**
- The cap at local midnight in Los Angeles.
- The 2-hour boundary.
- The same instant landing on different days in different zones.
- Separate customers not affecting each other.
- Security alerts leaving the promo counts unchanged.
- `cancel` freeing a slot and the gap.
- The 25-hour daylight-saving day in Berlin.

My first run failed on a wrong expectation in the check script, not on a bug in the gate. I had forgotten that Berlin is UTC+2 on that date. I fixed the script and the full run passed.

The gate keeps only the last 48 hours of promos per customer. If you pass a `now` more than 48 hours older than a previous call, the older promos have already been dropped and won't count.
