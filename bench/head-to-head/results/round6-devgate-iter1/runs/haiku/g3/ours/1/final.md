I wrote `bot.mjs` in the working directory. It has the three exports and no dependencies. The logic checks pass (13 cases) and 25 concurrent unsubscribe writes from separate processes all landed. Nothing was sent.

**Decision for you: newsletters are blocked by default.** `REQUIRE_EXPLICIT_OPT_IN = true` at the top of the file. The gate only knows about `recordResubscribe` events, so any marketing email to an address with no such event returns `no_opt_in`. That covers everyone on the list who never re-signed up. To keep your existing subscribers receiving newsletters, either call `recordResubscribe` for each of them once, or set the constant to `false`. With `false`, marketing is allowed unless an unsubscribe is in effect, which matches CAN-SPAM's opt-out model.

**How it works**
- **Identity:** addresses are normalized so `"Jane <<EMAIL>>"` and `<EMAIL>` are one person. `+tags` are dropped on every domain and gmail dots are dropped. This errs toward matching, which is the safe direction for opt-outs.
- **Storage:** each event is one appended JSON line in `STATE_DIR/optout/<sha256>.jsonl`, fsynced. There is no read-modify-write, so workers cannot overwrite each other. `STATE_DIR` is read on every call and created if missing.
- **Out-of-order events:** the gate keeps the latest unsubscribe and the latest resubscribe by the provider's `at`. A resubscribe only counts if it is strictly later than the unsubscribe, so a late-arriving older signup does not undo an opt-out.
- **Transactional:** receipts and password resets are always allowed, including after an unsubscribe. CAN-SPAM exempts them. Keeping marketing content out of them is the caller's job.
- **Marketing:** held if unsubscribed, or if there is no opt-in and the flag is on.

**Other choices**
- **Reason codes:** `reason` is a snake_case code, as your spec requires. The skill asks for a full sentence instead, so the two conflict here and I followed your spec.
- **No quiet hours:** there is no timezone in the message, and CAN-SPAM sets no send-time window. I did not add any.
- **Fail closed:** unknown kind, invalid address, invalid `now`, unset `STATE_DIR`, or an unreadable log all hold marketing. A corrupt or partially written log line holds that address until someone repairs the file.
- **No redelivery claim:** `mayEmail` gets no message id and only checks. Your sender needs its own id-keyed idempotency so a retried send is not counted twice.
- **No inbound STOP:** email has no keyword opt-out in this API. Unsubscribes come only through `recordUnsubscribe`.

**Self-check results:** the inline run covered transactional vs. marketing, the opt-in and unsubscribe orderings (including a tie and a late older resubscribe), Gmail alias matching, invalid inputs, and a missing `STATE_DIR`. All passed. The 25-process race check also passed.
