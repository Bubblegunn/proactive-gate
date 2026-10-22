`bot.mjs` is written in the project root. It exports `recordUnsubscribe`, `recordResubscribe` and `mayEmail`, and it passed an inline self-check against a temp `STATE_DIR`. Nothing was sent and nothing was committed.

**How it works**
- Each unsubscribe or resubscribe is one JSON file in `STATE_DIR/events/<hash of address>/`. Writes go through a temp file and `rename`, so workers never touch the same file and readers never see a partial one.
- `mayEmail` reads that directory on every call. Nothing is cached, so a restarted worker sees the same state.
- An address is opted out when its latest unsubscribe is at or after its latest resubscribe. Out-of-order arrivals are handled by comparing the `at` times, not arrival order. A tie counts as opted out.
- Addresses are normalized before lookup: display names and `<...>` are stripped, case is folded, `+tags` are dropped, `googlemail.com` maps to `gmail.com`, and dots are removed for Gmail. Stripping merges addresses, so an opt-out covers more mailboxes. That is the safe direction.
- `transactional` (receipts, password resets) is never blocked by an opt-out. `marketing` is blocked after an unsubscribe.
- If `STATE_DIR` is unset or unreadable, marketing fails closed with `state_unavailable`.

**Self-check results**
- Unsubscribe blocks marketing for the alias forms `<EMAIL>` and `googlemail.com`. Transactional still passes.
- A resubscribe with a later `at` clears the opt-out. An earlier resubscribe that arrives late does not.
- Five concurrent unsubscribe writes were all recorded and the address is blocked. No temp files were left behind.
- Unknown `kind` and invalid `to` are held.

**Choices you should check**
- **Marketing to non-opted-out addresses is allowed.** `mayEmail` only receives `{to, kind}`, so it cannot tell a newsletter from an agent-drafted "we miss you" email. I treated both as the subscriber list. If the "we miss you" emails go to people who never subscribed, give them their own kind or pass a consent field, and the gate can hold them.
- **Reasons are snake_case codes** (`unsubscribed`, `unknown_kind`, `invalid_recipient`, `invalid_message`, `state_unavailable`), as your spec says. The skill's guidance asks for plain sentences, but your API definition takes precedence.
- **No quiet hours or time windows.** Nothing in the request asks for them and CAN-SPAM has no time-of-day rule, so `now` is accepted but unused.
- **Unsubscribes take effect immediately.** CAN-SPAM allows 10 business days; Gmail and Yahoo expect 2 days. Immediate is the stricter choice.
- **No send-side idempotency.** The three functions only record and check. Send-once claims, if you need them, belong in the send path.
- **No fsync** after writes. A power loss right after a write could drop that event.
