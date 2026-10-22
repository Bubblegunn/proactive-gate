`bot.mjs` is written in the working directory and passes my tests. Nothing was sent.

**How it works**
- All state lives in `STATE_DIR/suppression/`, one append-only log per address (named by SHA-256 of the normalized address). Workers only append, so concurrent writers can't lose each other's events. Each write is fsynced before the promise resolves.
- Address matching is deliberately broad: case, whitespace, display names and angle brackets (`Jane <<EMAIL>>`), `+tags` on all domains, `googlemail.com` → `gmail.com`, Gmail dots, and IDN domains. Over-matching costs one skipped email; under-matching sends mail after an opt-out.
- Each address's state is its latest unsubscribe and latest resubscribe, by the `at` you pass. Arrival order doesn't matter. An exact tie goes to unsubscribe.
- `mayEmail`:
  - Marketing is blocked with `unsubscribed` once the latest event is an unsubscribe.
  - Transactional mail (receipts, password resets) is never blocked by an opt-out. CAN-SPAM exempts it and people expect it.
  - Invalid recipient → `invalid_recipient`. Unknown kind → `unknown_kind`. Both fail closed.
  - Opt-outs apply immediately, which is stricter than the 10-business-day CAN-SPAM window and Gmail/Yahoo's 2-day expectation.
- `recordUnsubscribe` and `recordResubscribe` throw `TypeError` on an unusable address or invalid `at`, rather than dropping the event silently.

**Tests** (kept outside the repo, all pass)
- Rules: marketing blocked after unsubscribe, transactional allowed, resubscribe restores marketing, out-of-order events, tie handling, invalid input.
- Torn write (crash mid-append) doesn't break later events.
- Six concurrent child processes × 100 events on one address: all 600 records present and parseable.

**Choices and gaps for you to confirm**
- Node 24 is installed here; the code uses only Node 22-compatible APIs but I ran it on 24.
- Concurrency assumes a local POSIX filesystem. NFS-style shares don't guarantee `O_APPEND` atomicity.
- The module has no subscriber list, so it can't block addresses that never subscribed. Only the caller can make sure marketing goes only to people on the list.
- Spam complaints from the provider's feedback loop aren't covered by a separate event. Record them with `recordUnsubscribe`.
- `now` is accepted but not used. Opt-outs apply regardless of `at` versus `now`, to allow for clock skew.
- `kind` is trusted. The AI agent's "we miss you" emails must be labelled `marketing`, or they bypass the opt-out check.
