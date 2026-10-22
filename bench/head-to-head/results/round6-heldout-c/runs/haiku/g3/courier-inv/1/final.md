`bot.mjs` is written and all 8 tests pass. Nothing was sent.

I did not use the Courier skill's guidance. It covers the Courier notification service, and this module makes no Courier API calls. I read the skill and then wrote the module directly.

**How it works**
- **State:** one append-only file, `STATE_DIR/suppression.log`. Each `unsubscribe` and `resubscribe` appends a JSON line and fsyncs before returning, so it survives a kill.
- **Concurrency:** writers use O_APPEND. Readers track their byte offset and only parse complete lines, so a half-written line from another worker is ignored.
- **Corruption:** a corrupt line makes `mayEmail` throw instead of allowing mail. Skipping it could email someone who opted out.
- **Addresses:** trimmed and lowercased. Invalid input returns `allowed: false` with a reason.
- **Rules:**
  - Marketing is blocked after an unsubscribe until a later `resubscribe`. The latest event wins.
  - Receipts are never blocked by an unsubscribe. They are transactional under CAN-SPAM and GDPR.
  - Unknown kinds are denied.
  - Every deny has a one-sentence reason that a support person can read.

**Tests** (`bot.test.mjs`, run with `node --test`): normalization, resubscribe, invalid input, the unset `STATE_DIR` error, state surviving a fresh process, a partial trailing line, and 8 processes × 50 concurrent unsubscribes with all 400 recorded.

**Gaps you should decide on**
- **EU consent is not modelled.** Under ePrivacy and GDPR, marketing to EU recipients needs prior opt-in. The API only has `resubscribe`, not a consent record from signup. So today marketing is allowed to anyone who has not unsubscribed, which is the US opt-out model. Your signup flow needs to record opt-in, and `mayEmail` needs to check it for EU addresses. Without that, the EU side is not compliant.
- **Unsubscribe covers marketing only.** Receipts still go out. If a request means "stop all email", the signature needs a scope argument.
- **`now` does not affect decisions.** It is only validated. An unsubscribe recorded by any worker always applies.
- **Not handled:** bounces, spam complaints, and the 10-business-day honouring window. Neither is in the API.
- **Log growth:** the file grows without limit. Each worker keeps an in-memory index and reads only new bytes, but the file needs rotation or compaction eventually.
