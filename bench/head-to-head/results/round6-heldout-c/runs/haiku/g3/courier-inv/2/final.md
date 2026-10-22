`bot.mjs` is written in the work directory and passes 10 tests, including a 30-process concurrent write test. I have not committed it.

**Rules it enforces**
- **Marketing** is allowed only after a `resubscribe` that is newer than any `unsubscribe`. An address with no record is blocked.
- **Receipts** are always allowed. A marketing unsubscribe does not stop order, shipping, or password-reset mail.
- Addresses are trimmed and lowercased before use. Dot and plus aliases are not merged.
- `reason` is always a short sentence for support staff.

**Storage**
- One append-only JSONL file per address under `STATE_DIR/consent/`, named by the SHA-256 of the address. Each write is fsynced, and the directory is fsynced when a file is created.
- A worker killed mid-write leaves a torn line. Readers skip it, and the next record starts on a new line so it is not corrupted.
- `STATE_DIR` is created on first write.

**Decisions to check**
- **First-time signups must call `resubscribe`.** The default is to block marketing without an opt-in record, since the EU rules require prior consent and the function gets no country. If the website only calls `resubscribe` on a re-signup, marketing will be blocked for everyone who never unsubscribed. That is the intended behaviour, but the website has to be wired to it.
- **`now` is validated but not used.** None of these rules depend on time. Unsubscribes take effect immediately, so there is no delay window to apply.
- **Concurrent writes.** Two workers unsubscribing the same address at the same moment can both append. The result is still correct, but the file can hold a duplicate line.
- **Newest record wins.** If a resubscribe and an unsubscribe for the same address land at nearly the same moment, whichever line was appended last decides.

**Testing**
- The suite is in `/tmp/courier-bot-test/test.mjs`, outside the work directory. It ran on Node 24.13.0 only. The APIs used exist in Node 22, but I have not run it on 22.
- The suite checks: normalization, resubscribe then unsubscribe ordering, idempotency, a torn-line crash, invalid inputs, the unset `STATE_DIR` error, 30 concurrent processes, and a fresh process reading earlier state.

The Courier skill covers Courier's hosted send API, which this module does not call. If you want the suppression list synced to Courier preferences later, that is a separate change.
