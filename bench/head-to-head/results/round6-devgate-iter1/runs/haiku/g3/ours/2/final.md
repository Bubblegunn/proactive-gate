I wrote `bot.mjs` in the project folder. The inline self-test passed. Nothing is sent.

**How it works**
- `recordUnsubscribe` and `recordResubscribe` write one file per event into `STATE_DIR/events/<sha256 of address>/`. The file name is `<provider time ms>-<type>.json`. Each write goes to a temp file and is then renamed, so workers don't corrupt each other and a restart loses nothing.
- Out-of-order events are handled by provider time, not arrival order. The latest event decides. At an equal time, unsubscribe wins.
- Addresses are normalized before keying: header form ("Name <a@b>") is accepted, case is folded, `+tag` is dropped, and gmail dots and googlemail.com are folded. This treats all addresses for one person as one opt-out, which is the conservative choice.
- `mayEmail`:
  - Transactional (receipts, password resets) is always allowed.
  - Marketing is held with `unsubscribed` if the latest event is an unsubscribe.
  - Invalid recipient or kind is held.
  - If `STATE_DIR` is unset or unreadable, marketing is held with `state_unavailable`. This fails closed.

**Self-test results** (one inline run, temp `STATE_DIR`):
- Unsubscribe then marketing to the same person in another spelling is held. Transactional to that address is allowed.
- A late unsubscribe that predates a later resubscribe does not block.
- Same-instant unsubscribe and resubscribe: unsubscribe wins.
- 30 concurrent unsubscribes for one address all land and block.
- Bad address, bad kind, bad `at`, and missing `STATE_DIR` each behave as specified.

**Choices and gaps to check**
- Reason codes are snake_case, as the spec asks. The skill's default asks for plain sentences, but the spec wins here.
- Marketing with no opt-out on record is allowed, because the gate only sees opt-out and resubscribe events. This assumes the caller queues marketing only for subscribers. If you need explicit opt-in before every promotion, you need a subscribe event that the API does not have.
- I added no quiet-hours or time-zone rule, because the message has no recipient zone and the spec states no such rule.
- There is no message id, so there is no send claim or redelivery guard. Add one if the queue can redeliver.
- `now` is accepted but unused. The decision depends only on event times.
- The machine runs Node 24. The code uses only standard APIs and should run on Node 22, but I did not test on 22.
