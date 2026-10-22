I wrote `bot.mjs` with the three exports, plus a test suite. All 9 tests pass. Nothing was sent and nothing was committed.

**Decision for you: EU marketing consent.** Marketing is allowed for any address with no record. That matches US opt-out rules, but EU rules need prior opt-in for marketing mail. This module has no record of initial sign-up consent, only unsubscribes and resubscribes. If EU recipients get newsletters, the consent record has to come from your sign-up system, and the default for unknown addresses should change. Tell me which way you want it.

**How it works**
- **Storage:** one append-only file per address under `STATE_DIR/suppression/`, named by the SHA-256 of the normalized address. Concurrent workers append with `O_APPEND`, so no locks are needed. The last event in a file decides the state.
- **Durability:** `unsubscribe` and `resubscribe` resolve only after `fsync`. An acknowledged opt-out survives a worker being killed.
- **Torn writes:** each record starts with a newline, so a fragment left by a killed writer cannot swallow the next record.
- **Normalization:** addresses are NFKC-normalized, trimmed, and lowercased before matching.
- **Marketing:** blocked after an unsubscribe until a later `resubscribe`. The reason is one sentence with the date of the unsubscribe.
- **Receipts:** always allowed, even after an unsubscribe. Transactional mail is not blocked by a marketing opt-out.
- **Invalid input:** a malformed address or an unknown kind returns `allowed: false` with a reason.
- **Errors:** a missing `STATE_DIR`, a non-string email, or an invalid `now` throws. Callers should treat a rejection as "do not send".

**Choices to check**
- `now` is validated but does not affect the decision. Suppression follows file order, not wall-clock time, so clock skew between workers cannot make a fresh opt-out look like it is in the future.
- `unsubscribe` takes effect immediately, which satisfies the 10-business-day rule in CAN-SPAM.
- A send that `mayEmail` approved just before an unsubscribe was acknowledged can still go out. That is an inherent race.

**Verification:** `node --test test/bot.test.mjs` passes 9/9 on Node 24.13. Node 22 is not installed here, so I could not run it on 22. I used only APIs present in Node 22. The tests cover normalization, resubscribe ordering, invalid input, a torn line, six concurrent worker processes writing 120 unsubscribes to one address, and a worker killed right after an unsubscribe resolves.

Files are in the working directory:
- `bot.mjs`
- `test/bot.test.mjs`
