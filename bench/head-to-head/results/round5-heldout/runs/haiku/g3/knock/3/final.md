`bot.mjs` is written at the work directory root and passes a 10-check test suite, including 200 concurrent unsubscribes from 8 processes with no lost lines. It sends nothing. I did not commit it.

**Behavior**

- **Storage:** each worker appends one JSON line per event to `STATE_DIR/suppression/<hash>.jsonl`, with fsync. Every `mayEmail` call re-reads the file, so any worker sees the state after a restart. `STATE_DIR` is read per call; if it is unset, the call throws.
- **Addresses:** input is trimmed; `Name <addr>` and `mailto:` forms are accepted. Matching is case-insensitive and punycode-aware. `+tag` aliases match the base address on any domain. On Gmail, dots are ignored and `googlemail.com` maps to `gmail.com`. Malformed input throws from the record functions, so the webhook can retry. `mayEmail` returns `invalid_recipient` for it.
- **Out-of-order events:** the decision uses the provider's `at` timestamps, not arrival order. A marketing email is blocked while the latest unsubscribe is not older than the latest resubscribe. A resubscribe stamped after `now` is not yet effective, and an unsubscribe always counts. A tie goes to the unsubscribe.
- **Transactional mail:** order receipts and password resets are never blocked by an unsubscribe, and they do not read the ledger. Marketing returns `{allowed:false, reason:"unsubscribed"}`. An unknown `kind` is blocked with `unknown_message_kind`.

**Tests:** the suite is in `/private/tmp/bot-test.TL5qJe/test.mjs`, outside the repo. It covers normalization, out-of-order and future-dated events, a torn line from a simulated crash, invalid inputs, and the missing `STATE_DIR` case. Two of my first test runs failed because of mistakes in the test code, not in `bot.mjs`; I fixed those and reran.

**Not covered by this module, so the caller must handle it**

- **Opt-in:** it cannot tell whether a marketing recipient ever opted in. Only the sender's subscriber list can establish that.
- **Kind labels:** the sender code must set `kind`, not the AI agent. A "we miss you" email labeled `transactional` would bypass the check.
- **Resubscribe source:** only an explicit opt-in may call `recordResubscribe`. A receipt or password reset must not.
- **Headers and frequency:** the `List-Unsubscribe` header, one-click unsubscribe, and any frequency cap belong in the sending code.
- **Clocks:** the provider's clock and the site's clock may differ, so ordering across them is only as good as their sync.
- **Race window:** an unsubscribe becomes effective only when its write returns. A send checked during that write could still go out.
