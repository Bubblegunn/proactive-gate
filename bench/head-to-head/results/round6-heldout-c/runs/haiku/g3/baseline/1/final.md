`bot.mjs` is written at the work directory root. All 10 tests pass on Node v24.13.0. I didn't run it on Node 22, and it uses only APIs that exist there. Nothing was sent and nothing was committed.

**How it works**
- **State:** everything lives under `STATE_DIR` (created if missing). Each address gets a folder named by a SHA-256 hash of its key, so no plain emails are stored. Each event is its own file, written to a temp name, fsynced, then renamed into place. Workers never overwrite each other's files, so no locks are needed. A killed worker leaves at most a `.tmp-*` file, which readers ignore.
- **Ordering:** file names sort by time in ms, then op. On an identical ms, unsubscribe sorts last and wins. The newest file is the current state.
- **Address matching:** trims, lower-cases, and drops a `+tag`, so `<EMAIL>` and `<EMAIL>` share a record. Over-matching is the safe error for an opt-out.
- **`unsubscribe` / `resubscribe`:** resolve only after the event is durable on disk. If a call rejects, the caller should retry.
- **`mayEmail`:**
  - `marketing` is blocked after an unsubscribe until a later resubscribe.
  - `receipt` is never blocked by an unsubscribe. Shipping, order and password-reset mail are transactional.
  - An invalid address blocks both kinds.
  - Unreadable state blocks marketing (fails closed).
  - Every result carries a plain-language `reason`.
  - Invalid `kind` or a non-Date `now` throws.

**Tests** (scratch suite at `/tmp/bot-check/check.mjs`, outside the work tree): rules, normalization, bad input, corrupted state, leftover temp files, a new process seeing earlier writes, and 24 concurrent worker processes.

**Gaps and decisions for you**
- **EU consent is not covered.** Under GDPR and ePrivacy, marketing to EU addresses normally needs prior opt-in consent. This module has no opt-in record: only unsubscribe and resubscribe are recorded, and the send gate never sees the recipient's country. So `mayEmail` allows marketing to any address without an unsubscribe on record. Your caller must send marketing only to addresses that consented, or the spec needs an opt-in export.
- **`now` does not change the decision.** It is validated and nothing else. No time-based rule applies with the data available.
- **Same-ms tie is not tested directly.** The code handles it, but the test only covers resubscribe alone.
- **Clock dependence:** ordering uses each worker's wall clock. This is fine on one machine. A backwards clock jump could reorder events.
- **Late unsubscribe after resubscribe:** the event time is the call time, so a delayed unsubscribe for an earlier request still wins if it runs after a resubscribe. Pass the original request time in if that matters.
