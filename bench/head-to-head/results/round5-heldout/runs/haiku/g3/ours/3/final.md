`bot.mjs` is written at `work/ours-g3-3/bot.mjs`. Its self-check passed: out-of-order events, redelivery, aliases, transactional mail, and 8 concurrent processes writing the same address. Nothing was sent. I did not commit.

**How it works**
- **State:** each unsubscribe or resubscribe is one file under `STATE_DIR/suppression/<hash>/`. It is published with `link()` after a full temp write, so workers never overwrite each other, no lock is needed, and a redelivered webhook is stored once.
- **Ordering:** the status of an address is the event with the latest `at`. On an exact tie, unsubscribe wins. A late resubscribe can't undo a newer unsubscribe, and a late unsubscribe can't undo a newer resubscribe.
- **Addresses:** `Name <addr>` form, case, and whitespace are normalized. `+tag` is stripped everywhere, and dots are stripped for gmail. So `Ann.Lee+shop@Example.com` and `ann.lee@example.com` are one person, and an opt-out sticks across aliases. Opting out on one alias suppresses the others.
- **`mayEmail`:**
  - Transactional (receipts, password resets) is always allowed, even after an unsubscribe.
  - Marketing is refused with `unsubscribed` when the latest event is an unsubscribe.
  - Invalid addresses return `invalid_address`, and unknown kinds return `unknown_kind`.
- **Bad input:** `recordUnsubscribe` and `recordResubscribe` throw a `TypeError` on a bad address or a non-Date `at`. The webhook handler then sees the failure and the provider can retry.

**Choices you should check**
- **No opt-in data:** the three functions take only address, time and kind, so the gate can't see signup consent. Marketing is allowed unless the person has unsubscribed. That fits your existing subscriber list, but the upstream list must only contain people who opted in. If you want the gate to enforce opt-in, it needs a consent field per address.
- **No quiet hours:** the message has no time zone, so I did not add a time-of-day window. A time-zone field would make that possible.
- **No frequency cap:** I did not add a limit on "we miss you" emails per address. Adding one would need a number from you.
- **Opt-out is immediate:** it takes effect on the next `mayEmail` call, which is well inside CAN-SPAM's 10-business-day rule and Gmail/Yahoo's expectations for one-click unsubscribe.
