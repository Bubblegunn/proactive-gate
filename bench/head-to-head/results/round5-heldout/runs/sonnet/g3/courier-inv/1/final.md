`bot.mjs` is written and checked. I did not send anything.

**Rules in `mayEmail`:**
- **Transactional** (receipts, password resets) is always allowed. CAN-SPAM exempts it, and people still need it after unsubscribing.
- **Marketing**, including the agent's "we miss you" mails, is blocked with reason `unsubscribed` once the person has unsubscribed. An opt-out takes effect immediately, even if the provider's clock is ahead of ours.
- **Bad input:** a message with an unparseable `to` returns `invalid_recipient`. A `kind` that is neither marketing nor transactional returns `unknown_kind`.

**Late and out-of-order events:** the event with the latest `at` decides.
- A late, older unsubscribe cannot undo a newer resubscribe.
- A resubscribe older than the unsubscribe is ignored.
- On an exact tie, the unsubscribe wins.

**Address matching:** the same mailbox cannot dodge an opt-out by how it is written. Header forms like `Name <a@b.c>`, `mailto:` prefixes, case and trailing dots are normalized. Plus-tags (`user+shop@…`) are stripped. Gmail dots are ignored and `googlemail.com` is treated as `gmail.com`. This can only suppress more marketing, never transactional mail.

**Shared state across workers:** each event is one small file under `STATE_DIR/optouts/<hash of address>/`. It is written to a temp name, synced to disk, then renamed. Files are never edited, so workers need no locks and a restart loses nothing. `STATE_DIR` is created if missing, and the functions throw if it is unset.

**Checks run:**
- A never-seen address is allowed.
- Dotted and plus-tagged variants are blocked after an unsubscribe.
- Transactional stays allowed after an unsubscribe.
- Old resubscribe, newer resubscribe, late old unsubscribe and tie cases all behave as described above.
- A fresh Node process reads the earlier state correctly.

I only ran these in a single process plus one fresh one, not with several workers writing at once. I also did not test the `invalid_recipient` and `unknown_kind` reasons beyond one bad address.

The Courier skill's guidance (preference topics enforced by Courier at send time) is for sends through Courier. You asked for a local gate that works from `STATE_DIR`, so I didn't use it here.
