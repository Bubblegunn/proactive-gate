I wrote `bot.mjs` and ran one check, which passed. The check ran 6 concurrent unsubscribes from a single process. It also ran a fresh process against the saved state after the events were written. It did not run separate worker processes in parallel, or restart a worker partway through.

**How it behaves**
- **Marketing and "we miss you" emails:** blocked with `unsubscribed` after an unsubscribe, until a later resubscribe. The agent's extra emails count as marketing. Any `kind` other than `transactional` is treated as marketing.
- **Transactional emails (receipts, password resets):** always allowed, because CAN-SPAM exempts them from opt-outs. People who unsubscribed would still expect these.
- **Newsletters and promotions with no opt-out recorded:** allowed. Your request doesn't list a consent field, so I assumed subscribers are opted in until they unsubscribe.
- **Address matching:** `Bob <<EMAIL>>`, ` <EMAIL> `, `mailto:<EMAIL>` and `<EMAIL>` all match the same person. An unparseable address on a marketing email is blocked with `invalid_address`.
- **Out-of-order events:** the event with the latest provider time `at` wins, not the one that arrived last. In the check, a late-arriving older resubscribe did not undo a newer unsubscribe. A tie goes to the unsubscribe.
- **Future-dated resubscribe:** a resubscribe stamped after `now` is not effective yet. Unsubscribes always count.
- **Shared state:** every event is its own file under `$STATE_DIR/optout/<hash of address>/`, written to a temporary file and then renamed. Workers never overwrite each other, and restarts lose nothing. `STATE_DIR` is read on every call.
- **Opt-out timing:** an unsubscribe takes effect immediately. CAN-SPAM allows up to 10 business days and Gmail/Yahoo allow 2 days, so this is stricter than both.

`recordUnsubscribe` and `recordResubscribe` throw on an invalid address or an invalid date.

Not checked: the late-arrival and tie cases only ran in one process, and nothing was sent.
