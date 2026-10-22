`bot.mjs` is written in the work directory and passes my checks. It is not committed.

**Rules I chose (review these, they are the main decisions):**

- **Marketing needs an opt-in on record.** Marketing is allowed only if the latest event for the address is `resubscribe` and there is no later `unsubscribe`. EU rules require prior consent, and the API gives no country, so I chose the stricter rule. Consequence: any address that has never called `resubscribe` is blocked from marketing. If your existing list has no opt-in records, marketing stops for all of them until consent is imported. If you want the looser default (allowed unless unsubscribed), it is a one-line change, but that is not EU-safe.
- **Receipts are always allowed**, even after a marketing unsubscribe. Transactional mail is exempt under CAN-SPAM and rests on the contract under GDPR. `unsubscribe` therefore blocks marketing only. If "unsubscribe" should mean "stop all mail", tell me.
- **Address matching:** trims, lowercases, drops `+tag`, maps `googlemail.com` to `gmail.com` and drops dots for gmail. All of these point to the same mailbox, so the matching errs toward suppressing more.
- **`now` is validated but does not affect the decision.** Ordering comes from the order records were appended, because worker clocks can differ.
- **Denial reasons** are short sentences a support person can read, e.g. "This person unsubscribed from marketing email at … and must sign up again on the website first."

**How it works:**

- All state is under `STATE_DIR/suppression/`, one append-only file per mailbox, named by the SHA-256 of the canonical address. No plaintext addresses are stored.
- Each write is a single append followed by `fsync`, so concurrent workers never rewrite each other's data. A killed worker can leave a torn record. The reader treats a torn record after the last valid event as damaged and blocks marketing until a new valid event is appended (fail closed).
- The directory is created on first write. `STATE_DIR` is read at call time, not import time.
- Invalid addresses throw in `unsubscribe`/`resubscribe`. In `mayEmail` they return `allowed: false`.

**Checks run:** I ran a test script from `/tmp/bot-test`, outside the work directory. It passed. It covered:
- unsubscribe, resubscribe and receipt behaviour;
- normalisation of case, spaces and gmail/plus aliases;
- invalid inputs;
- a torn record, which fails closed and recovers after a new event;
- 5 processes × 41 concurrent appends to one mailbox, with every line intact;
- a fresh process reading state written by earlier ones.

Nothing was sent. I have not reviewed the rules with a lawyer. The CAN-SPAM and GDPR/PECR points above are my reading of the regimes.
