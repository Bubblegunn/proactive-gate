I wrote `bot.mjs` in the working directory with the three exports. The 15 tests in `bot.test.mjs` pass with `node --test`, including restart and multi-process cases. Nothing was sent.

**How it works**
- **State:** each email gets its own append-only JSONL file under `$STATE_DIR/suppression/`. Writes are `O_APPEND` plus `fsync`, so they survive restarts and every worker sees them. There is no cache, so each check re-reads the file. The code throws if `STATE_DIR` is unset rather than falling back to local state.
- **Out-of-order events:** the latest unsubscribe and the latest resubscribe are each taken by their provider timestamp, so arrival order doesn't matter. Marketing is blocked when the latest unsubscribe is not followed by a strictly later resubscribe. A tie counts as unsubscribed.
- **Torn writes:** a line cut off by a crash is skipped. Each record starts with a newline, so a torn line can't swallow the next event.
- **Matching:** addresses are matched case-insensitively and ignore display names. The `+tag` is stripped for every domain, and Gmail dots and `googlemail.com` are folded too. An opt-out covers more addresses rather than fewer.

**`mayEmail` rules**
1. Malformed recipient → `invalid_recipient`.
2. Transactional (receipts, password resets) → always allowed. An opt-out from marketing doesn't block mail the person needs.
3. Marketing → blocked with `unsubscribed` unless resubscribed after the latest unsubscribe.
4. Unknown kind → `unknown_kind` (fail closed).

Because opt-outs take effect as soon as they are recorded, the `now` argument is validated but not used in the decision.

**Choices and limits to check**
- **Marketing default is allowed.** There is no subscribe event in the API, so anyone without an unsubscribe is allowed. Your queue must only contain shop subscribers.
- **The agent's "we miss you" emails must be sent as `kind: "marketing"`.** `mayEmail` can't detect promotional content in a message labelled transactional.
- **Clock skew.** Provider timestamps and our resubscribe timestamps come from different clocks, so a small skew can misorder an unsubscribe and a resubscribe made close together.
- **`STATE_DIR` must be on a local disk.** `O_APPEND` atomicity is not guaranteed on NFS.
- **Not in this module:** one-click unsubscribe headers (RFC 8058) and the sender-side opt-out handling Gmail and Yahoo expect for bulk mail. This module only enforces the suppression decision. From memory, those providers expect one-click unsubscribe and processing within about two days; I did not verify that against current sources. Here, opt-outs take effect immediately.
- **Skill guidance used:** the knock-notification-best-practices rules say to never send to unsubscribers and to keep transactional and marketing separate. They don't give statutory details, so the CAN-SPAM points come from my own knowledge of the statute and were not checked against it.

I did not commit anything. The files are `bot.mjs` and `bot.test.mjs` in the working directory.
