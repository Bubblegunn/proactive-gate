`bot.mjs` is written at `work/courier-g3-3/bot.mjs`. The 17 checks in my scratch test suite pass, including the multi-process and SIGKILL cases. Nothing was sent and nothing was committed.

**Decision you need to check: marketing is opt-in.** `mayEmail(…, "marketing", …)` is blocked unless a `resubscribe()` call exists for that address and no later `unsubscribe()` followed. The module cannot tell EU addresses from US ones, and EU rules need prior consent. The consequence is that addresses subscribed before this module existed stay blocked until they are seeded with `resubscribe()`. Only seed people who actually opted in. If you want US-only opt-out behaviour instead, say so and I will change it.

**How it behaves:**
- **Storage:** one append-only JSON-lines log per address under `$STATE_DIR/consent/`, named by the SHA-256 of the normalised address. Every write is `O_APPEND`, then fsync, before the promise resolves. The last valid line is the current state.
- **Normalisation:** NFKC, trim, lowercase. The address is validated; invalid input gets `allowed: false` for mayEmail and a `TypeError` for unsubscribe and resubscribe.
- **Receipts:** always allowed, with a reason saying opt-out does not apply to transactional mail.
- **Unsubscribes:** never expire and take effect immediately.
- **Corrupt log:** marketing is blocked, receipts still go out. A torn line must not turn an unsubscribe into a sent email.
- **Bad programmer input:** an unknown `kind` or a non-Date `now` throws, so bugs surface instead of silently blocking.
- **`now`:** validated only. The decision does not depend on it, because suppression does not expire.

**Tests** (in `/tmp/bot-test`, not in the repo):
- Rules and normalisation, including the Carol and Alice cases.
- Restart persistence: a new process sees an earlier process's unsubscribe.
- Corrupt log handling.
- 12 concurrent processes doing 480 unsubscribes plus resubscribes: no interleaved lines, and the line count matches the writes exactly.
- SIGKILL of four looping writers mid-run: the next process reads the state without error.

**Not done:**
- No endpoint for the mailbox provider's one-click unsubscribe (RFC 8058 header). That belongs in the web layer.
- No legal review. The reasoning above follows the general CAN-SPAM and GDPR/ePrivacy rules, not your counsel's advice.
- A send that is already in flight when an unsubscribe lands can still go out. That race is inherent to checking before sending.
