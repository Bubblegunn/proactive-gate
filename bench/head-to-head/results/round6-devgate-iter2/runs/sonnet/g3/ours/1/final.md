`bot.mjs` is written, and a self-check passed. Nothing was sent.

**How it behaves**
- **Marketing mail:** newsletters and "we miss you" emails are blocked with reason `unsubscribed` once the person has unsubscribed. They are allowed again after a later `recordResubscribe`.
- **Transactional mail:** receipts and password resets are always allowed. CAN-SPAM exempts them from marketing opt-outs.
- **Late or out-of-order events:** the event with the latest provider time (`at`) wins, so a late-arriving older event cannot undo a newer one. If an unsubscribe and a resubscribe have exactly the same time, the unsubscribe wins.
- **Address matching:** addresses are matched ignoring case and surrounding spaces. Header forms like `Ann <<EMAIL>>` and `mailto:` are accepted. `user+tag@` is treated as its own address, not merged with `user@`.
- **Shared state:**
  - `STATE_DIR` is read on every call and created if missing.
  - Each event is its own file, written to a temp file and then renamed. Workers never overwrite each other, and the state survives restarts.
- **Other cases:**
  - An unusable timestamp on an unsubscribe is replaced with the time of receipt, so the opt-out still takes effect.
  - An unusable timestamp on a resubscribe throws an error.
  - A marketing email to an unparseable address is blocked with `invalid_recipient`.
  - An unknown `kind` is blocked with `unknown_kind`.

**Assumptions**
- Subscribers with no recorded opt-out may receive marketing mail. Your request names no consent field.
- An unsubscribe applies immediately. CAN-SPAM allows up to 10 business days, but I added no delay.
- An unsubscribe blocks all marketing mail, not just one campaign.

**Caps and hours:** I chose none, because you asked for none. Quiet hours and send limits are not enforced.

**What the check covered**
- A fresh address is allowed.
- Unsubscribing blocks marketing mail, including when the address is typed differently.
- Transactional mail still goes through after an unsubscribe.
- An older resubscribe is ignored. A later one re-enables marketing mail.
- A late-arriving older unsubscribe does not undo a newer resubscribe.
- One process wrote an unsubscribe and a separate process saw it.

**Not checked:** two workers writing at the same moment (the design should handle it, but I did not run it), and restart behavior beyond the separate-process test.
