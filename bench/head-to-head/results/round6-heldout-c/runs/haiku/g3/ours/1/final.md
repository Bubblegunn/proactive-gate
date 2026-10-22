`bot.mjs` is written in the project directory and passes a self-check. The check ran in one process against a temp `STATE_DIR`. I did not run a separate cross-process or restart test.

**What it does**

- **`unsubscribe(email)`** writes one event file per call under `STATE_DIR/optout/<sha256 of address>/`. It writes a temp file, then renames it, so readers never see a half-written record. Unique file names mean concurrent workers never write the same path.
- **`resubscribe(email)`** writes the same kind of record with type `resubscribe`.
- **`mayEmail(email, kind, now)`** reads all records for the address on every call. It returns `{ allowed, reason }`.
  - Marketing is refused while the latest unsubscribe is not followed by a later resubscribe. The refusal says the date and how to re-enable.
  - Receipts are always allowed, since they are transactional. The reason says so.
  - An invalid address, unknown kind, or invalid `now` is refused with a plain sentence.
  - If the opt-out records can't be read, marketing is held (fail closed).
- Addresses are trimmed and lowercased before use. Only the trimmed, lowercased form is used, so case-sensitive local parts are treated as case-insensitive.

**Self-check results (all passed)**
- Marketing allowed before any unsubscribe.
- 20 concurrent unsubscribes with messy casing and spaces, then marketing refused.
- Receipt still allowed after unsubscribe.
- Resubscribe re-enables marketing.
- A later unsubscribe wins again.
- Invalid address, unknown kind, and invalid date are each refused.

**Choices and gaps to review**
- **No time-window or quiet-hours block.** The request doesn't state one and the API carries no time zone. `now` is only validated and not used for a block. If you need recipient-local send windows, the API needs a zone argument.
- **EU consent is not checked.** `mayEmail` receives no consent data, so marketing is allowed unless an unsubscribe is recorded. EU rules (ePrivacy/PECR) generally require prior opt-in for marketing email. This module cannot verify that. The caller must make sure only opted-in people reach `mayEmail` with `marketing`.
- **No redelivery protection.** `mayEmail` has no message id, so it cannot dedupe a retried send. The caller must claim each send by message id.
- **Receipts must stay free of promotional content.** Otherwise they stop counting as transactional.
- **Numbers chosen:** none. No caps, cooldowns, or hours are set.
