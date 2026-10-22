I wrote `bot.mjs`, and a test script I ran against it passed. The test covers address forms, event ordering, transactional mail, and unsubscribes recorded by four separate processes at once. Nothing is sent.

**How it behaves**
- **Marketing after an unsubscribe:** `mayEmail` returns `{allowed:false, reason:"unsubscribed"}` immediately. CAN-SPAM allows 10 business days to honor an opt-out, but Gmail and Yahoo expect about 2 days, so the stricter rule applies. This covers the agent's "we miss you" emails, as long as the caller marks them `marketing`.
- **Transactional mail:** receipts and password resets are always allowed, even to someone who has unsubscribed. They are the messages people still expect to receive, and CAN-SPAM exempts them.
- **Out-of-order events:** the event with the latest `at` decides the current state. A late-arriving old resubscribe does not undo a newer unsubscribe, and a late old unsubscribe does not undo a newer resubscribe. If the two events have exactly the same `at`, the unsubscribe wins.
- **Address matching:** `Ann <<EMAIL>>`, ` <EMAIL> `, `mailto:` and mixed case all refer to the same person. I did not strip `+tags` or Gmail dots.
- **Bad input:**
  - An invalid address returns `invalid_recipient`.
  - A `kind` other than `marketing` or `transactional` returns `unknown_kind`, and the email is blocked.
  - `recordUnsubscribe` and `recordResubscribe` throw if the address or date is invalid.
- **Storage:** each address gets its own append-only file under `$STATE_DIR/optout/`, which is created if missing. Each event is written with a single append and a sync to disk, so concurrent workers don't overwrite each other and a restart loses nothing. A half-written line left by a crash is skipped when reading.

`mayEmail` ignores `now`. The decision depends only on the recorded events, so an unsubscribe with a slightly future `at` from clock skew still blocks marketing.

The test script is `/tmp/bot-test.mjs`, outside the repo.
