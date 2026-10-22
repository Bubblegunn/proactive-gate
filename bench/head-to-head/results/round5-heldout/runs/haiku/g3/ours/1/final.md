I wrote `bot.mjs` in the working directory and it passes a self-check. Nothing was sent, and nothing is committed.

**How it works**

- **State:** each person gets an append-only JSON-lines file in `STATE_DIR/suppression/`, named by a hash of their address. Each write is appended and fsynced, so a restart keeps it and concurrent workers don't overwrite each other. `STATE_DIR` is read on every call.
- **Person key:** addresses are lowercased and header forms like `"Jane" <<EMAIL>>` are parsed. For gmail.com and googlemail.com, dots and `+tag` are dropped, so `<EMAIL>` and `<EMAIL>` are one person. Other domains keep the full address, since plus-tags are not the same mailbox there.
- **Ordering:** the event with the latest `at` decides, regardless of arrival order. An exact tie counts as unsubscribed.
- **`mayEmail`:**
  - Transactional mail (receipts, password resets) is always allowed, even after an unsubscribe.
  - Marketing is refused with `unsubscribed` once the newest event is an unsubscribe.
  - Refusal reasons are `invalid_recipient`, `unknown_kind`, `invalid_time`, and `state_unavailable`. The last one fails closed for marketing only.

**Self-check results** (script in a temp dir, outside the repo)

- All 13 rule checks pass: the alias merge, the late and older events in both directions, the non-gmail plus-tag case, invalid inputs, and state surviving a fresh import.
- 20 concurrent worker processes recorded unsubscribes for one address. All 20 landed; no event was lost.
- With `STATE_DIR` unusable, marketing is refused with `state_unavailable`.

**Choices and limits to know about**

- The input has no consent or list-membership field, so marketing is allowed unless the address unsubscribed. Callers must only queue subscribers. This is an assumption.
- Opt-out is global across all marketing. CAN-SPAM requires honoring it within 10 business days; this honors it immediately, which also meets the Gmail and Yahoo bulk-sender expectations.
- Quiet hours and frequency caps are not implemented because the spec did not ask for them.
- There is a small race: an unsubscribe recorded after `mayEmail` returns "allowed" but before the send can still go out. Closing that needs a claim-before-send step in the queue, which is outside this file.
