I wrote `bot.mjs`, and it behaves as intended in a test run. It exports `recordUnsubscribe`, `recordResubscribe` and `mayEmail`. Nothing was sent.

**What I ran:**
- **Unsubscribe:** a marketing email to `<EMAIL>` was blocked after an unsubscribe recorded as `Bob <<EMAIL>>`, and `<EMAIL>` was blocked too.
- **Out-of-order events:** a resubscribe with an older timestamp did not undo the unsubscribe. A resubscribe with a newer timestamp did allow marketing again. An unsubscribe that arrived late with an older timestamp did not re-block the address.
- **Concurrency:** eight separate processes each recorded an unsubscribe for `<EMAIL>` at the same time, and `mayEmail` then blocked it.

I did not test restarting a worker. State is written to disk before the function returns, so it should survive a restart.

**How it decides:**
- **Transactional email:** always allowed (`allowed: true`, `reason: null`). CAN-SPAM exempts receipts and password resets, and people still expect them after unsubscribing.
- **Marketing email:** blocked with reason `unsubscribed` if the address's latest event is an unsubscribe.
- **Latest event wins:** events are compared by the provider's `at` time, not by arrival order. If an unsubscribe and a resubscribe have the same timestamp, the unsubscribe wins.
- **Unreadable recipient:** if `to` can't be parsed as an address, `mayEmail` returns `allowed: false` with reason `invalid_recipient`. This applies even to transactional messages that reach that check.
- **Unknown `kind`:** any `kind` other than `"transactional"` is treated as marketing.
- **Address matching:** addresses are reduced to one form, so `Bob <<EMAIL>>`, `mailto:` links and different capitalisation all match. A `+tag` is dropped for every domain, so `<EMAIL>` counts as `<EMAIL>`. For Gmail, dots are ignored and `googlemail.com` is treated as `gmail.com`.
- **Storage:** each address has its own append-only log file under `$STATE_DIR/optouts/`. `mayEmail` works out the current state from that log each time, so workers share it without locks.
- **Bad timestamps:**
  - An unsubscribe with an invalid `at` is still recorded, using the current time, so an opt-out is never lost.
  - A resubscribe with an invalid `at` throws, because guessing a time could wrongly re-enable marketing.
  - An unparseable email address makes both record functions throw.

One thing to be aware of: unsubscribes are honoured immediately, with no 10-business-day grace. A resubscribe takes effect only if its `at` is later than the last unsubscribe.
