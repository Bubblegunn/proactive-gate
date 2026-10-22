`bot.mjs` is written and passed one inline check. I did not test concurrent writes from several workers at once.

The check covered:
- A fresh address is allowed.
- A header-form address like `Ann <<EMAIL>>` matches `<EMAIL>`.
- An unsubscribe blocks marketing but not transactional mail.
- A later resubscribe allows marketing again.
- A late-arriving older unsubscribe does not override a newer resubscribe.
- A newer unsubscribe blocks again.
- A second process that reads the same `STATE_DIR` sees the block.

**Rules**
- **Marketing:** blocked with reason `unsubscribed` when the address's latest event is an unsubscribe. The "we miss you" emails count as marketing. An unknown `kind` is treated as marketing.
- **Transactional:** receipts and password resets are always allowed. CAN-SPAM exempts them from opt-outs, and people expect to keep getting them.
- **Event order:** the event with the latest provider time (`at`) wins, not the one that arrives last. If an unsubscribe and a resubscribe have the same time, the unsubscribe wins.
- **Addresses:** matching ignores case, whitespace, `<...>` wrappers and `mailto:`. I did not strip `+tags` or Gmail dots. An unparseable marketing address is held with reason `invalid_address`.
- **Timing:** the opt-out takes effect immediately, which is faster than the 10 business days CAN-SPAM allows. Email stays blocked until a resubscribe is recorded, with no expiry. The `now` argument is unused.
- **Storage:** `STATE_DIR` is read on every call. Each event is one file under `STATE_DIR/optout/<hash of address>/`, written to a temp name and then renamed. Workers never overwrite each other's events, and state survives restarts.

No numbers were chosen, so there are no hours, caps or cooldowns to list.

I did not add checks for a missing unsubscribe link or footer in the message body. CAN-SPAM does require those in marketing email, but the gate only sees `{to, kind}`. Treat that as a separate check in whatever builds the message.
