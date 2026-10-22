I wrote `bot.mjs` with `recordUnsubscribe`, `recordResubscribe` and `mayEmail`. I checked it with a short script I wrote (`/tmp/check-bot.mjs`, run on Node 24), and it passed. Nothing is sent.

**Rules**
- **Transactional email:** always allowed, even to someone who unsubscribed. Receipts and password resets are exempt from CAN-SPAM opt-outs, and people still expect them.
- **Marketing email:** this includes the agent's "we miss you" emails. It is refused with reason `unsubscribed` when the address's latest event is an unsubscribe. The block applies right away, well inside CAN-SPAM's 10-business-day limit.
- **Event order:** the event with the later `at` time wins, so late or out-of-order events don't flip the result. A late resubscribe older than the unsubscribe is ignored. A later resubscribe re-enables marketing. If both have the same time, the opt-out wins.
- **Address matching:** addresses are matched case-insensitively. Forms like `Ann <<EMAIL>>` and `mailto:` are accepted.
- **Other reasons:**
  - A marketing message with an unparseable address is refused with `invalid_address`.
  - A message with a `kind` other than marketing or transactional is refused with `unknown_kind`.
- **Invalid input:** `recordUnsubscribe` and `recordResubscribe` throw on an unparseable address or an invalid `at`.

**State**
- The code reads `STATE_DIR` on every call and creates the directory if needed.
- Each event is a separate file, written under a temp name and then renamed. So concurrent workers never overwrite each other and no lock is needed, and everything survives restarts.

The test covers:
- case and header-form matching;
- the transactional exemption;
- both out-of-order cases;
- a fresh `STATE_DIR`;
- an allowed marketing send for an address with no events.

It does not run several processes at once, so the cross-worker behaviour rests on the temp-file-and-rename design.

**Choices I made:**
- Gmail-style dots and `+tag` aliases are not merged. `a+x@…` and `a@…` count as different addresses.
- Unsubscribes are never cleared by time, only by a later resubscribe.
- `now` is unused.
