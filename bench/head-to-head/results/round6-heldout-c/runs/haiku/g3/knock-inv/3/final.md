Wrote `bot.mjs` in the work directory. All 8 scratch tests pass. Nothing was sent.

**How it works**
- **State:** one append-only file per address at `STATE_DIR/optout/<sha256 of normalized address>.jsonl`. Every worker reads the same files, so nothing is held in memory and a restarted worker sees all prior records.
- **Writes:** each record is appended and fsynced before `unsubscribe()` or `resubscribe()` resolves. An acknowledged opt-out survives a kill.
- **Concurrency:** no locks. Appends are O_APPEND, and the last unsubscribe/resubscribe record in a file decides the state.
- **Addresses:** trimmed and lowercased before use. Invalid addresses make `unsubscribe`/`resubscribe` throw a `TypeError`.
- **`mayEmail`:**
  - `receipt` is always allowed, including after an unsubscribe, since the reason string says so.
  - `marketing` is denied after an unsubscribe until a resubscribe. The reason gives the unsubscribe date and tells support what to do.
  - Malformed address, unknown kind, or invalid `now` is denied with a reason.
  - If the record cannot be read, the result is denied (fail closed).

**Checks run**
- Unsubscribe blocks marketing but not receipts, with case and spacing normalized.
- Resubscribe restores marketing, and the latest record wins.
- Bad inputs and an unreadable record are denied.
- A torn trailing line is ignored.
- 40 concurrent worker processes unsubscribing the same address, plus mixed concurrent subscribe/unsubscribe, leave the expected final state.
- A SIGKILLed worker does not corrupt the file.

The SIGKILL test is weak: it only checks that the result is a boolean. The concurrency test checks the final state for one address, not the outcome of the mixed run.

**Gaps you should decide on**
1. **EU marketing consent.** GDPR and ePrivacy generally need prior opt-in for marketing email to EU recipients. The module can't tell where an address is, and "not unsubscribed" is not consent. As written, marketing is allowed by default. For EU customers you need an upstream opt-in check, or a recorded-consent export that the code would enforce. I did not add one because it goes beyond the three exports you specified.
2. **`now` is only validated.** Opt-outs take effect immediately, so the CAN-SPAM 10-day window never comes into play and `now` is not used for any decision. Tell me if you want it used, for example for quiet hours.
3. **Stored PII.** The record files contain the plaintext address for support, and the file name is a hash. If you need erasure, those files have to be deleted.
4. **Race window.** A `mayEmail` call that starts before an in-flight `unsubscribe` resolves can still see the old state. Once `unsubscribe` resolves, every later check sees it.
5. **Reply and one-click paths.** These must call `unsubscribe()` too. The module does not parse replies or handle the one-click request itself.

The skill's compliance section (CAN-SPAM, GDPR, CCPA, TCPA) is the basis for the receipt/marketing split and for the immediate, durable opt-out. The skill's own rules don't settle the EU consent question, so that one needs your legal review.
