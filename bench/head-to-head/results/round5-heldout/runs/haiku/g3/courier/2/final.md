`bot.mjs` is written and all 10 tests pass. Nothing was sent. I tested on Node v24.13 because that is what's installed here; I did not run it on Node 22. It uses only long-standing `node:fs/promises`, `node:crypto` and `node:child_process` APIs.

**Files** (in `courier-g3-2/`)
- `bot.mjs`: the three exports, no dependencies.
- `bot.test.mjs`: tests, run with `node --test bot.test.mjs`. This includes 20 separate processes writing the same unsubscribe at once, then a fresh process reading the result.

**How it works**
- **Storage:** each event is an empty file in `$STATE_DIR/suppression/<sha256 of canonical address>/`, named `unsubscribe-<ms>` or `resubscribe-<ms>`. Creating a file is idempotent and needs no lock, so workers can write at the same time and a restart loses nothing. The directory is created on first write.
- **Out-of-order events:** the event with the latest provider timestamp decides. On an exact tie, unsubscribe wins. An old event that arrives late cannot undo a newer one.
- **Addresses:** `"Name" <addr>` headers, case, `+tags` and `mailto:` are normalized. For gmail.com and googlemail.com, dots are also removed. An opt-out therefore covers every alias of the same mailbox.

**Rules in `mayEmail`**
- **Transactional** (receipts, password resets): always allowed. Recipients expect these, and they are not commercial messages.
- **Marketing:** blocked with reason `unsubscribed` as soon as the latest event is an unsubscribe. That is stricter than CAN-SPAM's 10 business days and Gmail/Yahoo's 2 days.
- **Bad input:** an unparseable `to` returns `invalid_recipient`, and an unknown `kind` returns `unknown_kind`. Both fail closed.
- Bad input to the record functions throws, so the webhook handler can return an error and let the provider retry.

**Choices you may want to change**
- `now` is accepted but unused. No rule here depends on time: an unsubscribe counts from when it is recorded, even if its provider timestamp is ahead of the local clock.
- Stripping `+tags` on every domain could, in rare cases, treat two different people as one. I chose that because it errs toward not emailing.
- Only the store holds a hash of each address, not the address itself.
- Only the site's real opt-in path should call `recordResubscribe`. The AI agent must never call it, or it could override a customer's unsubscribe.

**Not covered:** the module does not add the List-Unsubscribe headers, the one-click unsubscribe endpoint, or the spam-complaint limits Gmail and Yahoo require. Those belong in the sending code.
