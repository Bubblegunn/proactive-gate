`bot.mjs` is written and its 14 tests pass. I ran them on Node v24, the only Node on this machine, not Node 22. Nothing was sent and nothing was committed.

**Files**
- `bot.mjs`: the three exported functions, no dependencies.
- `bot.test.mjs`: the test suite (`node --test bot.test.mjs`). It's an extra file you didn't ask for; delete it if you don't want it.

**How it works**
- **Storage:** each person gets one append-only JSONL file in `STATE_DIR/optout-events/`, named by the SHA-256 of their canonical address. Each write is `O_APPEND` and fsynced, so workers can't overwrite each other and nothing acknowledged is lost on restart.
- **Torn writes:** each record starts with a newline, so a fragment left by a killed worker can't corrupt the record after it.
- **Marketing rule:** blocked when the latest `unsubscribe` is at or after the latest `resubscribe`, using the `at` timestamps. Arrival order is ignored, and ties go to unsubscribe.
- **Transactional rule:** always allowed, even after an unsubscribe. Receipts and password resets are expected by the list and fall outside the opt-out rules.
- **Address identity:** handles header forms (`"Name" <a@b>`) and `mailto:`. Plus-tags are stripped on every domain, Gmail dots are stripped, and `googlemail.com` maps to `gmail.com`. This makes suppression match more addresses, which is the safe direction.
- **Reason codes:** `unsubscribed`, `invalid_recipient`, `unknown_message_kind`.

**Limits and decisions for you**
- **The caller's `kind` is trusted.** The AI "we miss you" emails must be sent as `marketing`. This module can't check content, so a mislabeled promo would get through as transactional.
- **No opt-in record.** The API has no subscribe event, so `mayEmail` can't confirm a marketing recipient ever opted in. Adding a subscribe event would close that gap.
- **`now` is unused.** Opt-outs stay in force until a later explicit resubscribe, so the decision doesn't depend on the checking worker's clock.
- **In-flight race.** An unsubscribe that is still in transit when `mayEmail` runs can't be seen yet. Gmail and Yahoo expect opt-outs honored within about two days, so this is unlikely to matter, but the webhook handler should record events promptly.
- **Email headers are not handled here.** The `List-Unsubscribe` and one-click headers that Gmail and Yahoo expect belong in the sending code, not this module.
