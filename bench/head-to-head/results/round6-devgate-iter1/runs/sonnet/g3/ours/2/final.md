`bot.mjs` is written and passes my checks. Nothing was sent.

**Rules**
- **Marketing mail:** blocked for an unsubscribed address, with `reason: "unsubscribed"`. That covers newsletters and the agent's "we miss you" emails. Any `kind` other than `"transactional"` is treated as marketing.
- **Transactional mail:** always allowed, even to an unsubscribed address. Receipts and password resets are exempt from opt-outs under CAN-SPAM, and people still expect them.
- **Timing:** the opt-out takes effect on the next `mayEmail` call. That is faster than CAN-SPAM's 10 business days and Gmail/Yahoo's 2 days.
- **Order of events:** the newest event by provider time `at` wins.
  - A late-arriving old resubscribe does not undo a newer unsubscribe.
  - A late-arriving old unsubscribe does not cancel a newer resubscribe.
  - If an unsubscribe and a resubscribe have the same time, the unsubscribe wins.
- **Address matching:** case-insensitive, with spaces trimmed. `Ann <<EMAIL>>` and `mailto:<EMAIL>` match `<EMAIL>`. I did not strip `+tag` or dots, because those may be different mailboxes.

**State**
- STATE_DIR is read on every call. Each event is its own file under `STATE_DIR/optout/<hash of address>/`, written to a temp file, flushed to disk, then renamed into place.
- Workers never overwrite each other's events, so a worker restart or a simultaneous click on another worker cannot lose an opt-out.

**Choices that were mine**
- An unsubscribe with an invalid date is recorded as happening now, so it is never dropped. A resubscribe with an invalid date throws, because guessing could wrongly re-enable marketing.
- An unsubscribe dated in the future relative to `now` still blocks.
- `mayEmail` does not look at `now` in its decision.

**Checked**
I ran these in a temp STATE_DIR:
- A fresh address was allowed.
- An unsubscribe blocked marketing, left transactional allowed, and left other addresses allowed.
- Out-of-order resubscribe and unsubscribe events resolved as described above.
- Six parallel processes wrote 120 unsubscribe events with none lost and no leftover temp files.

**Not checked**
- A worker killed halfway through a write.
- Network filesystems, where rename is not guaranteed to be atomic.

**Not enforced**
- A check that marketing messages carry an unsubscribe link, postal address or header. `mayEmail` only receives `to` and `kind`, so it has no body to check.
