I wrote `bot.mjs` and ran one check, which passed. No email was sent.

**How it behaves**
- **Transactional email** (receipts, password resets) is always allowed. CAN-SPAM exempts these, and people still expect them after unsubscribing.
- **Marketing email** covers newsletters and the agent's "we miss you" emails. It is blocked with reason `unsubscribed` while the person's most recent unsubscribe is newer than their most recent resubscribe.
- **Ordering:** events are ordered by the provider's `at` time, not by arrival. A late-arriving older resubscribe cannot undo a newer unsubscribe. If the two have the same time, the unsubscribe wins.
- **Future-dated resubscribe:** ignored until its `at` time has passed. A resubscribe with an unusable date is dropped. An unsubscribe with an unusable date still applies, using the current time.
- **Address matching** is case-insensitive and ignores surrounding spaces, `"Name <<EMAIL>>"` header form and `mailto:`. It does not merge `+tag` or Gmail-dot variants, so those count as different addresses.
- **Other reasons:** marketing to an unparseable address returns `invalid_address`. A `kind` other than the two allowed values returns `unknown_message_kind`. Marketing sent to an address that has no unsubscribe on file is allowed, because your subscribers have consented by subscribing.
- **Shared state:** `STATE_DIR` is read on every call and created if missing. Each event is its own file, written to a temp file and then renamed. Several workers can write at once without overwriting each other, and the records survive restarts.
- **Not enforced:** there is no check on the email body, such as an unsubscribe link or a postal address. CAN-SPAM requires those, but I treated them as the message builder's job.

**What the check covered**
- A fresh address is allowed.
- After an unsubscribe, marketing is blocked and a receipt still goes through. A different address is unaffected.
- An older resubscribe does not lift the block, a newer one does, and a still-later unsubscribe blocks again.
- A malformed address is refused.

It did not cover concurrent writers from multiple processes or a restart. The design handles both, but I did not run them.

**Numbers I chose**
- No delay: an unsubscribe applies on the next `mayEmail` call. CAN-SPAM allows up to 10 business days.
- No expiry: unsubscribe records are kept indefinitely.
