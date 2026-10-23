`bot.mjs` is written and exports `createGate()`. My test script passed, but it only covers the cases listed below. Nothing is sent.

**How it behaves**
- **Promo:** a promo is allowed only if the customer has fewer than 3 promos on the current local day and the last promo was at least 2 hours earlier. Exactly 2 hours apart is allowed.
- **Local day:** a day runs midnight to midnight in the `timeZone` passed on that call.
- **Refusal rules:** `daily-cap` when the day's 3 are used, `min-gap` when the last promo was under 2 hours ago, and `invalid-timezone` when the zone name is missing or not valid. A refused call returns `id: null` and counts for nothing.
- **Order of checks:** if both limits apply, `daily-cap` is returned.
- **Security alerts:** always allowed and not counted toward the promo limits. They are transactional, so the promo cap and gap don't apply.
- **Other refusals:** `unknown-category` for any category other than `promo` or `security`, and `invalid-time` for a promo whose `now` isn't a valid Date.
- **`cancel(id)`:** removes that send, which frees its slot in both the cap and the 2-hour gap. Cancelling an unknown or already-cancelled id does nothing.
- **State:** it's all in memory, as you said, so it's lost on restart and not shared between processes. I did not use the skill's shared-state files for that reason.

**Checked in a test script:**
- 3 allowed, then `daily-cap`, then `min-gap`, at 08:00, 09:00, 10:00, 12:00 and 14:00 in Los Angeles.
- A security alert still goes through when the cap is full.
- `cancel` frees a slot, and cancelling twice or cancelling an unknown id is harmless.
- The cap resets after local midnight in Los Angeles.
- Different users and different zones are counted separately.
- The 2-hour gap: 119 minutes is refused and 120 is allowed.

**Not checked:**
- Daylight-saving days. The day boundary comes from `Intl`, which handles them.
- Calls arriving out of time order. The 2-hour gap is applied in both directions around each earlier send.

**Numbers I chose:** the cap is 3 promos per local day and the gap is 2 hours, as in your policy. I added no other limits, such as quiet hours.
