`bot.mjs` is written and exports `recordUnsubscribe`, `recordResubscribe` and `mayEmail`. A test script passed, and a fresh Node process still blocked marketing to an address I had unsubscribed. The test covered unsubscribing with a header-style address, a late older resubscribe, a newer resubscribe, a late older unsubscribe, and an exact tie. Nothing was sent.

**What `mayEmail` decides**
- **Marketing is blocked after an unsubscribe.** It returns `{ allowed: false, reason: "unsubscribed" }`. This covers the agent's "we miss you" emails too, since they are marketing. The block takes effect as soon as the event is recorded, which is faster than the 10 business days CAN-SPAM allows.
- **Transactional always goes through.** Receipts and password resets are allowed even for unsubscribed people, because those people still expect them.
- **An unrecognised `kind` is treated as marketing.** An unparseable marketing address returns `invalid_address`.
- **Late or out-of-order events resolve by the newest provider time.** A resubscribe wins only if it is later than the latest unsubscribe. On an exact tie, the unsubscribe wins.
- **A bad `at` on an unsubscribe counts as "now".** A bad `at` on a resubscribe is ignored, so a broken timestamp can't switch marketing back on.

**Addresses**
- **Normalisation:** `"Ann <<EMAIL>>"`, `mailto:` forms, surrounding spaces and mixed case all map to the same address.
- **Plus-tags:** `+tag` addresses are kept as distinct addresses.

**Shared state**
- **Storage:** each address gets one append-only file in `STATE_DIR`, created if missing. Every event is a single small append.
- **Concurrency and restarts:** workers don't overwrite each other, and a restart loses nothing.
- **Reads:** `mayEmail` re-reads the file on every call, so it sees events recorded by other workers immediately.

**Not done:** nothing here adds the unsubscribe link or postal address that CAN-SPAM requires in marketing emails, or the one-click unsubscribe header Gmail and Yahoo require. Those belong to whatever builds the emails.
