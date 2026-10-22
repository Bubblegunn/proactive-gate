I wrote `bot.mjs` in the work directory and checked it with a test script. It passes, including a run with 8 concurrent child processes.

**Design**
- **Storage:** each event is one JSON file under `STATE_DIR/consent/<sha256 of address>/`. Writes go to a temp file, are fsynced, then renamed into place. Renames are atomic and file names are unique, so concurrent workers never overwrite each other, and a killed worker leaves no half-written event that could be read.
- **Latest event wins.** Names sort by time. If unsubscribe and subscribe land in the same millisecond, unsubscribe wins.
- **Marketing needs opt-in.** Only a `resubscribe` (website signup) enables marketing. An address with no signup on record gets no marketing mail. This meets the EU prior-consent rule and is stricter than the US opt-out rule, so one rule covers both markets.
- **Unsubscribe is immediate.** It blocks marketing at once, which is safer than the 10-business-day window in CAN-SPAM.
- **Receipts still go out** after an unsubscribe. Order confirmations, shipping and password resets are transactional. This is my choice; if you want unsubscribe to block everything, it's a one-line change.
- **Normalisation:** trim, lowercase, NFC. I did not fold Gmail dots or plus-tags, since that could block the wrong person.
- **Failures:** invalid input returns `allowed: false` with a reason. Unknown kind, bad `now`, and a missing `STATE_DIR` also fail closed. Unsubscribe and resubscribe throw on invalid addresses.
- **`now` is only validated.** No time-based rule was specified, so none is implemented. There is also no way to pass a recipient's country, so the opt-in model is the only jurisdiction handling.

**Checks** (scratch script in `/tmp/bot-test/run.mjs`, not in the repo)
- Case and whitespace normalisation, opt-in, unsubscribe, receipts after unsubscribe, re-signup, and a later unsubscribe winning again.
- Bad kind, bad date, bad address, and missing `STATE_DIR`.
- 8 child processes writing concurrently, then a fresh process reading the same state.
- A leftover temp file is ignored.

Not covered: the same-millisecond tie-break is not tested directly, and the concurrent stage only checks that the state reads back consistently. I did not fsync the directory after rename, so a power loss right after a write could in principle lose that event on some filesystems. The `STATE_DIR/consent` layout also keeps a plaintext address in each event file, so GDPR erasure would need a delete step that is not implemented.

This is an engineering interpretation of the rules, not legal advice. Have counsel confirm it against your actual mail flows.
