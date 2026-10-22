`bot.mjs` is written and passes my checks. I checked the ordering rules, the address handling and six worker processes writing at once. Nothing was sent.

**Rules**
- **Marketing:** `mayEmail` returns `{allowed:false, reason:"unsubscribed"}` for an unsubscribed address. The block takes effect on the next check. CAN-SPAM allows 10 business days and Gmail/Yahoo expect 2 days, so this is stricter than both.
- **Transactional:** receipts and password resets are always allowed, because an unsubscribe covers marketing only.
- **Unknown kinds:** anything not exactly `"transactional"` is treated as marketing.
- **Unparseable address:** a marketing email to one returns `reason:"invalid_address"`.
- **Out-of-order events:** the event with the latest provider time wins, and an unsubscribe and resubscribe with the same time resolve to unsubscribed. A late-arriving older resubscribe does not undo a newer unsubscribe, and a late older unsubscribe does not undo a newer resubscribe.
- **Address matching:** `Bob <Bob@Example.com>`, `" bob@example.com "` and `mailto:` forms all match one address. A `+tag` is kept, so `a+x@` and `a@` count as different addresses.

**Shared state**
- Each address has its own append-only log file in `STATE_DIR`, named by a hash of the address. The directory is created if missing.
- Each event is one small append that is flushed to disk, so workers need no lock. State is recomputed from the whole log on every check, so a restart loses nothing and every worker sees the same state. A partly written line is ignored.

**What I ran**
- A scripted sequence of unsubscribe and resubscribe events in different orders gave the expected result at each step, with transactional mail allowed throughout.
- Six processes each recorded 50 unsubscribes for the same address at once. All 300 events were in the log.

`recordUnsubscribe` and `recordResubscribe` throw if the address or the time is invalid, so the webhook handler should catch that.
