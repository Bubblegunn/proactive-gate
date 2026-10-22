`bot.mjs` is written at `work/knock-g3-1/bot.mjs`. It has no dependencies and exports exactly the three functions. All 14 checks pass, including a 40-process race that ends with every fresh process reading the same result. The tests are in `/tmp/bot-check/bot.test.mjs`, outside the repo. I ran them on Node 24 because that is the local binary; I did not run them on Node 22. The code only uses standard `node:` modules. Nothing was sent and nothing was committed.

**How it works**
- **Storage:** each event is a file under `STATE_DIR/suppression/<sha256 of address>/`. Writes go to a temp file, are fsynced, then renamed. No locks or in-memory cache are needed, so workers see the same state and restarts lose nothing.
- **Out-of-order events:** the decision compares the latest unsubscribe with the latest resubscribe, using the provider's `at` times. A late unsubscribe that is older than a resubscribe does not block. A tie counts as unsubscribed.
- **Address matching:** accepts `"Name <<EMAIL>>"` header form, ignores case, drops `+tag` sub-addresses, maps `googlemail.com` to `gmail.com`, and ignores dots only for Gmail.
- **Transactional mail:** always allowed after an opt-out. CAN-SPAM covers commercial messages only, and receipts and password resets are what people still expect.
- **Marketing mail:** blocked with reason `unsubscribed`. If the ledger cannot be read, it is blocked with `suppression_state_unavailable`, so it fails closed.
- **Other reasons:** `invalid_recipient` for malformed addresses. Bad arguments throw a `TypeError`.

**Things you need to decide or check**
- **`kind` is trusted from the caller.** The agent's "we miss you" emails are unsolicited marketing. If they are queued with `kind: "transactional"`, they skip the opt-out check. Those must be passed as `marketing`.
- **Check-then-send race:** an unsubscribe recorded after `mayEmail` returns but before the send still goes out. Re-checking at send time narrows this but does not remove it.
- **`now` is validated but not used.** None of the rules needs it; all comparisons use provider timestamps.
- **Not covered here:** Gmail and Yahoo's bulk-sender requirements (one-click `List-Unsubscribe` headers, 2-day processing, complaint-rate limits) belong in the sending code, not this module. The module processes opt-outs immediately, which is stricter than the 10-business-day CAN-SPAM window.
- **No frequency cap:** the spec does not define one, so none is enforced. Adding one would need the module to record sends.
