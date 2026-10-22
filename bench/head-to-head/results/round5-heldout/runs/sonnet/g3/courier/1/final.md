`/bot.mjs` is written and works in my tests. I did not send anything.

**Rules**
- **Marketing:** it is blocked with reason `unsubscribed` while the address's latest event is an unsubscribe. Emails queued by the "we miss you" agent count as marketing.
- **Transactional (receipts, password resets):** always allowed. CAN-SPAM exempts them from opt-outs, and people still expect them. A message with any other `kind` is treated as marketing.
- **Late or out-of-order events:** the event with the latest provider time `at` wins. An unsubscribe and a resubscribe with the same time resolve as unsubscribed. A resubscribe older than the unsubscribe has no effect, and a late-arriving older unsubscribe does not undo a newer resubscribe.
- **Timing:** an unsubscribe applies on the next `mayEmail` call, with no 10-day delay. CAN-SPAM allows up to 10 business days, but Gmail and Yahoo expect fast handling.
- **Address matching:** addresses match whether they appear as `Name <<EMAIL>>`, `mailto:` or plain text. Case, surrounding spaces, a `+tag` and a trailing dot after the domain are ignored. For Gmail, dots and `googlemail.com` are also ignored.
- **Bad input:** an unsubscribe with an invalid `at` uses the current time instead of being lost. A resubscribe with an invalid `at` throws, as does an address that can't be parsed.

**Storage**
- **Where:** each address has an append-only log in `STATE_DIR/events/`, created if missing. Appends are single writes and are synced to disk, so concurrent workers need no lock and a restart loses nothing.

**Tests**
I ran separate Node processes against a fresh state directory. All of these passed:
- Unsubscribe, then a stale resubscribe, then a newer resubscribe, then a later unsubscribe.
- Transactional mail to an unsubscribed address.
- Header-form and alias addresses.
- Eight concurrent writers, which left every event in the log.

I didn't add an automated test file.
