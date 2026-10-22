`/bot.mjs` is written and passed my checks. I ran it as separate Node processes sharing one temporary `STATE_DIR`. I didn't send anything.

**What it does**
- **Transactional mail:** receipts and password resets are always allowed, because CAN-SPAM exempts them from opt-outs.
- **Marketing mail:** an unsubscribe blocks all of it, including the agent's "we miss you" emails. It returns `{ allowed: false, reason: "unsubscribed" }`.
- **Unknown kinds:** anything that isn't `"transactional"` is treated as marketing, so a mislabelled message is blocked rather than sent.
- **Invalid addresses:** a marketing message to a malformed address is blocked with `invalid_address`.
- **Address matching:** `Ann <<EMAIL>>`, `mailto:` prefixes, extra spaces and upper case all resolve to the same person. I did not merge `+tag` variants, since those can be separate mailboxes.
- **Late or out-of-order events:** the event with the latest provider time (`at`) decides. A resubscribe only re-allows marketing if its time is later than the latest unsubscribe. An old resubscribe arriving late does nothing, and a late-arriving old unsubscribe doesn't undo a newer resubscribe. If the times are equal, the unsubscribe wins.
- **Bad dates:** an unsubscribe with an unusable `at` is recorded as of now, so the person is suppressed. A resubscribe with an unusable `at` throws.
- **Storage:** each event is saved as its own empty file under `STATE_DIR/events/<hash of the address>/`, and the file name holds the event type and time. Workers never rewrite a shared file, so concurrent unsubscribes can't overwrite each other. Files are fsynced, so events survive a restart, and every worker sees them straight away.
- **Setup:** `STATE_DIR` is created on first write, and the functions throw if it isn't set.

**What I tested**
- No record: marketing allowed.
- Unsubscribe in `Ann <<EMAIL>>` form: marketing to `<EMAIL>` blocked.
- Transactional to the same address: allowed.
- Older resubscribe: still blocked.
- Newer resubscribe: allowed.
- Late-arriving old unsubscribe: no effect.
- Malformed address: blocked with `invalid_address`.
- 8 simultaneous unsubscribe processes for one address: all 8 events were saved and the address was blocked.

**What I didn't do**
- **No same-timestamp test:** I didn't test an unsubscribe and resubscribe with the same timestamp.
- **No unsubscribe delay:** the unsubscribe applies immediately rather than after a delay, which is stricter than CAN-SPAM's 10 business days and matches the Gmail/Yahoo expectation of fast opt-outs.
