I wrote `bot.mjs` in the project directory. All 7 tests pass. I ran them from `/tmp/bot-check`, outside the repo, and nothing was sent.

**How it works**
- **State:** each change is one new file under `STATE_DIR/consent/<hash of the address>/`. A file is written to a temp name, fsynced, then renamed into place. A worker killed mid-write leaves no partial record and no lock to clean up. A restarted worker reads the same files.
- **Addresses:** trimmed and lowercased before use, so `" Shopper@Example.com "` and `"shopper@example.com"` are the same person.
- **Marketing:** allowed only if the latest `resubscribe` is later than the latest `unsubscribe`. If the two timestamps are equal, the address counts as unsubscribed.
- **Receipts:** allowed for any valid address, even after a marketing unsubscribe.
- **Failures:** an unknown kind or invalid address returns `allowed: false`. Invalid `now` or invalid email in `unsubscribe`/`resubscribe` throws, and corrupt state throws, so the caller doesn't send.
- **Reason text:** every block has a one-sentence reason a support person can read.

**Judgment calls to check**
1. **Marketing needs opt-in, not just "not unsubscribed."** You sell to the EU, where marketing email needs prior consent. So an address that never opted in gets no newsletters. First-time sign-ups must call `resubscribe` to record consent, because you gave me no other opt-in call. If you want a separate name, it's a one-line alias.
2. **Unsubscribe doesn't block receipts.** Order, shipping, and password-reset mail is transactional. If you want unsubscribe to block everything, change the receipt branch.
3. **`now` is only validated.** Every recorded change counts regardless of timestamp, so a worker with a slightly stale clock can't send after an unsubscribe.

**Tests:** the suite covers the rules above, unsubscribe winning a same-millisecond tie, fail-closed inputs, 20 processes writing the same unsubscribe at once, and a fresh process reading the state. The local runtime is Node v24. The code uses only APIs that exist in Node 22, but I did not run it on Node 22.
