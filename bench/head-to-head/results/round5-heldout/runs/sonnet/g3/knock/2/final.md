`bot.mjs` is written and passed my single-process check. I did not test several workers writing at once, or a restart.

**How it works**
- **Storage:** each unsubscribe or resubscribe is saved as its own small file under `$STATE_DIR/optouts/`, in a folder named from a hash of the normalized address. Files are written to a temporary name, flushed to disk, then renamed. Workers need no locks, a restart loses nothing, and a half-written event is never read.
- **Late and out-of-order events:** an address's current status comes from all its events. The event with the latest `at` wins, and an exact tie goes to unsubscribed. A late "unsubscribe at Jan 2" cannot undo a "resubscribe at Jan 3", and an older resubscribe cannot undo a newer unsubscribe.
- **Address matching:** the address is trimmed and lowercased. `Ann <<EMAIL>>` and `mailto:` forms are reduced to the bare address. I did not strip `+tag` parts or Gmail dots, because that could suppress a different mailbox.
- **Marketing mail:** it is blocked with `unsubscribed` when the address is currently opted out. The block applies immediately, with no 10-business-day delay.
- **Transactional mail:** receipts and password resets are always allowed, because CAN-SPAM exempts them and people still expect them after opting out. This includes "we miss you" emails only if they are marked transactional, which they should not be. Any `kind` other than `"transactional"` is treated as marketing.
- **Unusable addresses:** a marketing message to an address that can't be parsed is blocked with `invalid_address`. Recording an event for an unparsable address does nothing. An invalid `at` date falls back to the current time.

**What I ran:** with a temporary `STATE_DIR`, I checked all of these:
- A new address is allowed.
- An unsubscribe with mixed-case input and a `Name <…>` header blocks marketing mail.
- Transactional mail is still allowed.
- An older, late resubscribe does not lift the block.
- A newer resubscribe does lift it.
- A late, older unsubscribe afterwards does not re-block the address.
