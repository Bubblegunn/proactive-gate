`bot.mjs` is written and passed my checks. Nothing was sent. The checks ran in separate Node processes that shared one temporary `STATE_DIR`, including 20 unsubscribes recorded at the same time, and all of them held.

- **Storage:** each address gets its own log file in `STATE_DIR`. Every event is added as one line and synced to disk. Workers never rewrite each other's data, and a restart loses nothing.
- **Address matching:** `"Bob <<EMAIL>> "`, `mailto:` forms and any capitalisation all count as the same address. `<EMAIL>` is treated as a different address from `<EMAIL>`.
- **Transactional mail:** receipts and password resets are always allowed, even to someone who unsubscribed. CAN-SPAM exempts them.
- **Marketing mail:** this includes the agent's "we miss you" emails. It is blocked with `unsubscribed` for anyone whose latest event is an unsubscribe, and the block has no expiry. It takes effect as soon as the event is recorded, which is well inside the 10 business days the law allows. Because the Gmail/Yahoo bulk-sender rules also expect honoured opt-outs, nothing here relies on a delay.
- **Late or out-of-order events:** the event with the latest provider time wins, so a late-arriving older resubscribe does not undo a newer unsubscribe, and the reverse also holds. If two events have the same time, the unsubscribe wins.
- **Bad input:** an unsubscribe with an invalid date is recorded as happening now, so it is never lost. A resubscribe with an invalid date throws an error. A marketing message to a malformed address is blocked with `invalid_address`. A message with any kind other than `transactional` is treated as marketing.
- **`now` is unused:** `mayEmail` accepts `now` but ignores it, because an unsubscribe never expires.
- **Unsubscribe link and sender address:** the unsubscribe link, one-click header and postal address in each email are not part of this file. Those still need to be in the email templates.
