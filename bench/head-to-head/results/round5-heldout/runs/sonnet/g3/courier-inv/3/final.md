`bot.mjs` is written and works in my checks. I did not send anything.

**Rules it applies**
- **Unsubscribe:** all marketing email to that address stops, including the agent's "we miss you" emails and newsletters. The block is immediate, which is inside CAN-SPAM's 10-business-day limit. `mayEmail` returns `{ allowed: false, reason: "unsubscribed" }`.
- **Transactional:** receipts and password resets are always allowed. CAN-SPAM exempts them, and customers expect them to keep arriving.
- **Other kinds:** any `kind` other than `"transactional"` is treated as marketing, so an unexpected value gets blocked rather than sent.
- **Event order:** the event with the latest `at` decides. A resubscribe only counts if it is newer than the unsubscribe, and a late-arriving older event can't undo a newer one. On an exact tie the unsubscribe wins.
- **Bad timestamp:** an `at` that can't be read is treated as "now", so an opt-out is never lost.
- **Address matching:** addresses are trimmed and lowercased. Header forms like `Jane <<EMAIL>>` and `mailto:` prefixes are accepted.
- **Shared state:** each event is saved as its own file under `STATE_DIR/optouts/`, written to a temp name and renamed into place. Workers can't overwrite each other, a restart loses nothing, and a duplicate webhook delivery is harmless. `STATE_DIR` is created on first write.

**What I ran**
- I used a fresh temporary `STATE_DIR` and two concurrent unsubscribes for the same address, written in different formats.
- Marketing was blocked afterwards, and transactional was still allowed.
- An older resubscribe was ignored, and a newer one re-enabled marketing.
- A late-arriving older unsubscribe did not override the newer resubscribe.
- A separate Node process, simulating a restart, read the same state.

I did not run a stress test with many worker processes writing at once.

I used the Courier skill, but it covers Courier's own sending API, which doesn't apply to a local gate like this one. Nothing in `bot.mjs` calls Courier.
