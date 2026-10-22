`bot.mjs` is written and all 11 tests pass. Nothing is sent; the module only returns the decision.

Files are in `work/baseline-g2-2/`:
- `bot.mjs` exports `decide(candidate, now)`.
- `bot.test.mjs` has the tests, run with `node --test bot.test.mjs`.

**Behavior:**
- **Transactional** pushes always return `{ send: true, rule: null }`. They are never capped and never held for quiet hours, and they don't count toward the marketing cap.
- **Marketing** pushes are checked in this order, and the first rule that matches is the one reported:
  1. `quiet-hours`: the customer's local time is inside their window. The window can cross midnight, and the end time is exclusive.
  2. `daily-cap`: the customer already has 3 marketing sends on their local calendar day.
  3. Otherwise it sends and records the send.
- A push blocked by quiet hours does not use up the day's cap.
- The local day and time come from `Intl.DateTimeFormat` in the customer's IANA zone, so the cap resets at their local midnight, not UTC midnight.
- State is a `Map` of userId to local date to count. Each send removes that user's older day entries, so memory stays bounded.
- Bad input throws: an unknown timezone, a malformed "HH:MM", an unknown category, an empty userId, or an invalid Date.

**Choices you should check:**
- **Quiet hours apply to marketing only.** The brief says a courier notice must always get through. It does not say whether the DND window also covers transactional pushes, so I let them through. If the product team wants DND to hold everything, change the transactional branch.
- **`quietStart === quietEnd` means no quiet hours.** I picked this rather than "all day".
- **Quiet hours are checked before the cap.** So a blocked push reports `quiet-hours` even when the cap is also full.

**Not verified:** The sandbox has Node v24.13.0, not Node 22. The code uses only features Node 22 supports, but I did not run it on 22.
