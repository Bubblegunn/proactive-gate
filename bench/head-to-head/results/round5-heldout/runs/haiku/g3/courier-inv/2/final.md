`bot.mjs` is written in the work directory and checked. Nothing was sent, and I did not commit.

The Courier skill did not change the design. It covers the Courier send API, and this is a local suppression list, so I wrote it directly.

**What the code does**
- **Storage:** one append-only file, `STATE_DIR/suppression.log`, one JSON line per event. Each write is fsynced, so an opt-out survives a crash. `STATE_DIR` is created if missing and must be set.
- **Out-of-order events:** the latest event by the provider's `at` wins, not arrival order. On an exact tie, unsubscribe wins.
- **Multiple workers:** each process reads only the bytes appended since its last read, so it sees the other workers' writes.
- **Addresses:** `"Name <addr>"` and `mailto:` forms are accepted. Case is ignored, and `+tag` suffixes are stripped. For Gmail, dots are also ignored, and `googlemail.com` maps to `gmail.com`.
- **Transactional mail:** never blocked by an unsubscribe, since CAN-SPAM exempts it and password resets and receipts are expected.
- **Marketing mail:** blocked with `unsubscribed` if the address's latest event is an unsubscribe. Also returns `invalid_address` for a bad address and `unknown_message_kind` for any kind other than `marketing` or `transactional` (fails closed).
- **Exports:** only the three you asked for. `mayEmail`'s `now` is validated but not otherwise used, because the rule depends only on the provider's `at` timestamps.

**Checks run (scratch dir in /tmp, outside the work tree)**
- In-process: allow, unsubscribe, transactional exemption, alias and header matching, a resubscribe that arrives before an older unsubscribe, a later unsubscribe after a resubscribe, the same-instant tie, bad input, and error cases. All pass.
- Restart: a fresh process still sees the earlier opt-outs. Passes.
- Concurrency: 8 processes wrote 400 events at once. The log has exactly 400 lines and all 400 addresses are blocked afterwards.
- Missing `STATE_DIR` is created on first write. An unset `STATE_DIR` throws. `node --check` passes.

**Caller duties this file cannot enforce**
- Label messages `transactional` only when their primary purpose is transactional. A "we miss you" email must be `marketing`, even if it includes an order reference.
- Spam complaints should also call `recordUnsubscribe`. Gmail and Yahoo treat complaints as opt-outs.
- Gmail and Yahoo require one-click unsubscribe in bulk mail. This file honors an opt-out immediately, which is inside their 2-day window.
- Opt-outs are per mailbox. A person who uses unrelated addresses is not linked.
- The log stores normalized addresses in plain text, so it needs the same retention and access rules as other personal data.

I have not reviewed these rules against the current statutory or provider text. This is an engineering reading, not legal advice.
