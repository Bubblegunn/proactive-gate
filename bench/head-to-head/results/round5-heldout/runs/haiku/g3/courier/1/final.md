`bot.mjs` is written at the work directory root (`work/courier-g3-1/bot.mjs`). It has no dependencies and sends nothing. Its checks pass: 40 concurrent worker processes wrote to the same address, and a fresh process read the state back correctly.

**Rules it enforces**
- **Marketing** (newsletters and the agent's "we miss you" drafts) is blocked with reason `unsubscribed` once the person unsubscribes. The block holds until a resubscribe is strictly later than the newest unsubscribe.
- **Transactional** (receipts, password resets) is never blocked by an unsubscribe. CAN-SPAM exempts these, and recipients expect them.
- **Ordering** uses the provider's `at` clock, so late or out-of-order events resolve correctly. An exact tie goes to the unsubscribe.
- **Identity** is per person, not per string. Case, display name, `+tag`, and Gmail dots are ignored, and `googlemail.com` maps to `gmail.com`. An unsubscribe on `<EMAIL>` therefore covers `<EMAIL>`.
- **Clock skew:** a resubscribe stamped after `now` is ignored, so a skewed clock cannot re-enable marketing.
- **Failure mode:** bad input returns `invalid_recipient` or `unknown_message_kind`. A missing `STATE_DIR` throws, so the queue sends nothing.

**Storage:** one immutable JSON file per event under `STATE_DIR/email-events/<sha256(identity)>/`. Each write goes to a temp file and is renamed into place, so no locks are needed and re-recording an event is idempotent.

**Caveats**
- The gate trusts the caller's `kind`. If the agent labels a "we miss you" email `transactional`, it bypasses suppression. The caller must enforce that marketing is never tagged transactional.
- Plus-addressing is stripped on every domain, not just Gmail. Two distinct people on a non-Gmail domain who use `+tags` could be treated as one. I chose this to over-suppress rather than under-suppress.
- No frequency cap is implemented, because the spec did not ask for one.
- Crashed writers can leave `.tmp-*` files. They are ignored by readers and harmless.
- Nothing is committed.

**Scratch files:** I overwrote `/tmp/bot-check/check.mjs`, which already existed with other files in that directory. My checks now run from fresh `mktemp` directories. I did not touch any other files in `/tmp`.
