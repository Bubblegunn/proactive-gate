`bot.mjs` is written in the working directory and exports `createGate()`. My check script (`/tmp/gate-check/check.mjs`, outside the repo) passes. Nothing was sent.

**Behavior**
- **Daily cap:** at most 3 promos per customer per local day. The day is computed from the `timeZone` you pass, via `Intl`, so DST is handled. A denial returns rule `"daily-cap"`.
- **Gap rule:** a promo is denied if it falls less than 2 hours from any promo already recorded for that customer. Exactly 2 hours is allowed. A denial returns rule `"min-gap"`. If both rules would stop a request, `"min-gap"` is reported.
- **Security:** always allowed, with an id. These pushes are never counted against the promo limits and are never blocked, even if `timeZone` or `now` is bad.
- **Recording:** an allowed promo is recorded immediately, since the caller sends right away.
- **`cancel(id)`:** removes that send, so it no longer counts toward the cap or the gap. Cancelling an unknown, security, or already-cancelled id does nothing.
- **Bad promo input:** denied with `"invalid-category"`, `"invalid-time"` or `"invalid-time-zone"`, so the gate never throws.
- **Memory:** records older than 48 hours are dropped as each customer's next request comes in.

**What the check covered**
- Gap boundary: 1:59:59 is denied and 2:00:00 is allowed.
- The 3 per day cap in Los Angeles.
- Reset at local midnight, on the Los Angeles side of the March DST change.
- Berlin day rollover.
- Different users stay independent.
- Security is unaffected by the promo limits.
- `cancel` frees both the cap and the gap, and repeated or unknown cancels are harmless.
- Bad time zones.

The first run of my check script failed because of a wrong timestamp in my test, not a bug in `bot.mjs`. I fixed the test and it passed on the rerun.

I did not commit anything.
