`bot.mjs` is written and works in my check. I ran it from a temp `STATE_DIR` and nothing was sent.

**Rules it applies**
- **Transactional mail:** receipts and password resets are always allowed, even to someone who unsubscribed. CAN-SPAM exempts them.
- **Marketing mail:** any `kind` other than `"transactional"` is treated as marketing, including the "we miss you" emails. It is blocked with `reason: "unsubscribed"` when the person's latest event is an unsubscribe.
- **Out-of-order events:** the event with the latest `at` wins, so a late-arriving older event can't undo a newer one. If an unsubscribe and a resubscribe have the same `at`, the unsubscribe wins.
- **Future resubscribe:** a resubscribe dated after `now` is not yet in effect. Unsubscribes always count.
- **Address matching:** `"Ann <<EMAIL>>"`, `"mailto:<EMAIL>"` and `" <EMAIL> "` all match the same person.
- **Invalid marketing address:** blocked with `reason: "invalid_address"`.
- **Invalid input to the record functions:** `recordUnsubscribe` and `recordResubscribe` throw on an invalid address or date.
- **Unsubscribes take effect immediately.** CAN-SPAM allows up to 10 business days; I used none of that.

**Shared state**
- `STATE_DIR` is read on every call and the directories are created as needed.
- Each event is its own file under `STATE_DIR/email-events/<sha256 of address>/`. It's written to a temp file and then renamed, so two workers writing at once can't lose an event, and a replayed event does nothing new.
- `mayEmail` reads those files on each call, so a restarted worker sees the same state.

**What I checked**
- A fresh address is allowed.
- An unsubscribe blocks marketing, and an unsubscribed address still gets transactional mail.
- An older resubscribe doesn't override a newer unsubscribe, and a newer resubscribe does.
- A late-arriving older unsubscribe doesn't undo a newer resubscribe.
- Another address is unaffected.
- A separate Node process saw an unsubscribe recorded by a different process.

**Not checked:** many workers writing the same address at the same moment. The write design should handle it, but I didn't run that case.

**Two assumptions**
- Someone with no events on file is allowed marketing mail. You didn't say whether a never-subscribed address needs an explicit opt-in, so I didn't add that block.
- I did not collapse Gmail dots or `+tags`, because those can be different mailboxes.

I did not commit anything.
