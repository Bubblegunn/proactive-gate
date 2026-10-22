Wrote `bot.mjs` with the three exports, plus `bot.test.mjs`. All 10 tests pass (`node --test bot.test.mjs`). I ran them on Node 24 locally; the code only uses APIs that exist in Node 22, but I didn't run it on 22.

**How it works**
- State lives in `$STATE_DIR/subs/<sha256 of address>.jsonl`. The directory is created if missing. Each event is one JSON line, appended with `O_APPEND` and fsynced before the call resolves.
- Order comes from file order, not timestamps, so workers that record in the same second can't reorder each other's events. The test with 24 concurrent worker processes unsubscribing in the same second records all 24.
- A torn line from a killed worker is skipped, and the next record still reads correctly. The test covers this.
- Addresses are trimmed, lowercased, and stripped of zero-width characters. Plus-tags and dots are kept as-is, since they can be different mailboxes.
- Errors reject, so a worker that gets a rejection should not send.

**Rules I chose. Please confirm these:**
1. **Marketing needs an opt-in on record.** An address with no `resubscribe` on record gets `allowed: false`. I chose this because EU rules require prior consent and this API can't tell where a recipient is. The side effect: **the newsletter signup flow must also call `resubscribe` on a first signup**, not only on a re-signup. If it doesn't, new subscribers will be blocked.
2. **Unsubscribe blocks marketing only.** Receipts (order confirmations, shipping, password reset) are always allowed, since they are transactional.
3. **`now` is validated but does not affect the decision.** I found no rule in the spec that needs it. If you have a time-based rule in mind, tell me and I'll add it.
4. **Invalid addresses get `allowed: false` with a reason**, not an exception. `unsubscribe` and `resubscribe` throw `TypeError` on invalid input.

**Not covered**
- The state directory holds raw email addresses (only the filenames are hashed). Retention and erasure requests are not handled.
- This is not legal advice. CAN-SPAM, for example, also requires a postal address and other content in marketing mail, which this module doesn't check.

I haven't committed anything.
