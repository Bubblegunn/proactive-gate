`bot.mjs` is written at `work/baseline-g3-2/bot.mjs` and passes my tests. Nothing was sent.

**How it works**
- All state is in `STATE_DIR/suppression/<sha256 of address>.jsonl`. Each unsubscribe or resubscribe appends one line with `O_APPEND` and fsyncs before resolving, so any worker sees it after a restart.
- The last event for an address decides. Unsubscribe blocks marketing until a deliberate resubscribe. Receipts are never blocked by an unsubscribe.
- Addresses are normalised (NFKC, trimmed, lowercased) before use, so `  <EMAIL> ` and `<EMAIL>` are the same address.
- A line that can't be parsed blocks marketing for that address (fail closed) and says so in the reason. Receipts still go out.
- Bad arguments throw instead of returning `allowed: true`. That covers an unknown `kind`, a non-Date `now`, and an invalid address.

**Tests** (in `/tmp/bot-test`, not in the repo)
- Behaviour: fresh address allowed, unsubscribe blocks marketing but not receipts, resubscribe re-enables, re-unsubscribe blocks again, bad inputs throw.
- Restart: a new process sees the earlier unsubscribe.
- Concurrency: 200 processes appended at once. All 200 lines were intact JSON, and all 5 addresses were blocked by real unsubscribe records.
- Corruption: a torn line blocks marketing with the "unreadable" reason and leaves receipts allowed.

I ran these on Node 24 (the machine's default). I did not run them on Node 22. The code uses only `node:fs/promises`, `node:crypto` and `Array.prototype.at`, which Node 22 has.

**Decisions for you**
- **EU opt-in is not enforced.** EU marketing email generally needs prior opt-in consent. The module only knows the address, not the customer's country or whether they opted in at checkout. As written, `marketing` is allowed for any address that has not unsubscribed. If EU customers need opt-in, the checkout flow has to record consent, and I would add a `subscribe(email, ...)` export and make `marketing` require it. I did not add that because the spec lists only three exports.
- **`now` does not change the decision.** It is validated but unused, because unsubscribes take effect immediately. Tell me if you want a delay or quiet hours.
- **`receipt` is trusted as transactional.** Any mail a caller labels `receipt` is allowed even if the address unsubscribed. Callers must not put marketing content under that kind.
- **Unsubscribe is not per-channel.** Its only effect is on marketing. If you want "stop everything" for one-click or reply-STOP requests, that needs a separate call or a scope argument.
- **Corrupt records stay blocked.** Nothing clears a corrupt file automatically, so support has to repair it by hand.
