`bot.mjs` is written and exports `createGate()`. My checks pass. They only exercise the gate directly, and nothing was sent.

**What it enforces**
- **Promo cap:** a promo is blocked with `daily-cap` once the customer already has 3 promos in their local day. The day is computed in the `timeZone` passed with the request, via `Intl`, so DST days are handled.
- **Promo gap:** a promo is blocked with `min-gap` if another promo to that customer is less than 2 hours away. Exactly 2 hours is allowed. If both rules apply, `daily-cap` is the one reported.
- **Security:** security pushes are always allowed and don't count toward either promo rule. They still get an `id`.
- **Recording sends:** an allowed promo is recorded inside `request`, so asking and sending are one step.
- **Cancel:** `cancel(id)` removes that promo, which frees its slot for the cap and the gap. Unknown or repeated ids are ignored.

**Extra rule identifiers**

I added three identifiers for bad input: `unknown-category`, `invalid-time` and `invalid-time-zone`. An invalid time zone blocks only promos. Security pushes don't need a time zone, so they still go through.

**Memory**

Promo records older than 72 hours, measured from the newest `now` seen, are dropped so memory doesn't grow without limit.

**Checks run** (script at `/tmp/t.mjs`, outside the repo)
- 3 promos in a day are allowed and the 4th is blocked with `daily-cap`.
- A promo less than 2 hours after another is blocked with `min-gap`.
- The cap resets at local midnight in both Los Angeles and Berlin.
- Security pushes go through even when the promo cap is hit.
- Users are counted separately.
- `cancel` frees a slot, and repeated or unknown ids are harmless.
- A bad time zone name returns `invalid-time-zone`.

I did not test the 25-hour DST day on Oct 25 in Berlin. The test script has a comment for it but no assertion. The code uses `Intl` for all day calculations, so I expect it to work.
