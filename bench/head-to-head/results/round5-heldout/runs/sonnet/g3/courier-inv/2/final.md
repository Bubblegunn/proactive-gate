`bot.mjs` is written and works in my test run. It exports `recordUnsubscribe`, `recordResubscribe` and `mayEmail`. I sent nothing. The Courier skill only covers the Courier send API, so I didn't use it for this part. The logic follows CAN-SPAM directly.

- **Storage:** every event is its own small file under `$STATE_DIR/optouts/<hash of address>/`. Each file is written to a temporary name, flushed to disk, then renamed. Workers don't need locks, and a restart or crash can't leave a half-written record. All workers see the same state.
- **Address matching:** the address is lowercased and trimmed. `Ann <<EMAIL>>`, `mailto:` and trailing dots on the domain are handled. Plus-tags and dots are not collapsed, because they might be separate mailboxes.
- **Late and out-of-order events:** the event with the latest provider time (`at`) wins. A late resubscribe that is older than the unsubscribe is ignored. If an unsubscribe and a resubscribe have the same timestamp, the unsubscribe wins.
- **What `mayEmail` allows:**
  - Marketing mail, including the agent's "we miss you" emails, is blocked with `unsubscribed` for opted-out addresses.
  - Transactional mail (receipts, password resets) is always allowed, as CAN-SPAM permits.
  - Other outcomes are `invalid_recipient` for a bad address and `unknown_kind` for any other `kind`.
- **Bad dates:**
  - An unsubscribe with an invalid date is recorded as happening now, so it still blocks marketing.
  - A resubscribe with an invalid date throws, so a bad date can't re-enable email by mistake.
- **Timing:** unsubscribes take effect immediately, well inside the 10 business days CAN-SPAM allows.

What I ran, with a temporary `STATE_DIR`:
- An unsubscribe blocks marketing for differently cased and formatted forms of the address, and transactional mail stays allowed.
- An older resubscribe is ignored, a newer one re-enables marketing, and an equal-time unsubscribe wins.
- 20 concurrent unsubscribes were all recorded.
- Bad addresses and unknown kinds return the right reasons.

I did not test several separate worker processes or a restart in the middle of a write.
