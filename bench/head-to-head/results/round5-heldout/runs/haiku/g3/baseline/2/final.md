`bot.mjs` is written at `work/baseline-g3-2/bot.mjs`, exporting `recordUnsubscribe`, `recordResubscribe` and `mayEmail`. It passes the in-process checks and a cross-process test. I didn't commit it.

**How it works**
- **Storage:** each person gets one append-only file, `STATE_DIR/optouts/<sha256>.jsonl`. Writes use `O_APPEND` plus `fsync`, so concurrent workers don't overwrite each other and events survive restarts. Late or out-of-order events are ordered by their `at` time when a decision is made.
- **Identity:** addresses are normalized before lookup. This covers `"Name <addr>"` headers, `mailto:`, case, whitespace, `+tag` aliases, Gmail dots, and `googlemail.com`. The `+tag` stripping can over-suppress a little, which is the safer error here.
- **Marketing:** blocked (`unsubscribed`) once an unsubscribe is recorded, unless a resubscribe is strictly later. A tie goes to the unsubscribe.
- **Transactional:** order receipts and password resets are always allowed. An opt-out doesn't block them.
- **Fail-closed cases:** an unknown `kind` returns `unknown_kind`, and an unusable address returns `invalid_recipient`. Bad `Date`s and bad addresses in the record functions throw. Read errors other than "file not found" reject, so nothing is sent on a state error.

**Verification**
- In-process checks cover the rules above, out-of-order events, the tie case, re-unsubscribe, and 50 concurrent writes. All pass.
- 20 separate Node processes wrote concurrently; all 20 events landed. A new process then read the blocked state, and a later resubscribe cleared it while transactional mail stayed allowed.
- I ran on Node v24.13. The code only uses APIs that exist in Node 22, but I did not run it on Node 22 itself.

**Decisions for you to check**
- `now` is validated but does not change the result. Any "wait N days" rule would need it.
- The caller must tag the "we miss you" emails as `marketing`. Anything tagged `transactional` skips the opt-out check.

**Not covered**
- Gmail/Yahoo bulk-sender rules beyond opt-outs: sending rate, complaint-rate limits, authentication (SPF/DKIM/DMARC), and List-Unsubscribe headers. Those belong in the sending path.
- Frequency caps on "we miss you" mail. Nothing limits how often the agent can email one person.
- Bounce and complaint suppression, and the physical-address and footer requirements in CAN-SPAM.
- Wiring the webhook into `recordUnsubscribe`. The file doesn't parse webhook payloads.
- Log compaction. Each person's file only grows with their own events, so this is small in practice.
