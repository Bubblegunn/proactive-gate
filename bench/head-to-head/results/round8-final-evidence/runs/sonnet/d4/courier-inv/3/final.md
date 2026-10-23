`bot.mjs` is written and tested. It exports `recordEvent` and `checkEmail`, and nothing is sent. The test passed: one script (outside the project) that records events in a fresh `STATE_DIR`, runs 8 processes at once, then checks from a new process.

**Rules**

| Situation | `allowed` | `rule` |
|---|---|---|
| Address has a hard bounce, any kind | false | `hard_bounce` |
| Marketing, address has a spam complaint | false | `spam_complaint` |
| Marketing, address has unsubscribed | false | `unsubscribed` |
| Address can't be parsed | false | `invalid_address` |
| `kind` is not "marketing" or "transactional" | false | `invalid_kind` |
| State directory can't be read | false | `state_unavailable` |
| Otherwise | true | `""` |

**Decisions you should check**
- **Transactional mail after an unsubscribe or complaint:** it still goes out. CAN-SPAM only covers promotional mail, and receipts and password resets are mail the person needs. If you want complaints to block transactional mail too, that is one extra check in `checkEmail`.
- **Unsubscribe time:** an unsubscribe takes effect immediately, which is stricter than CAN-SPAM's 10 business days.
- **Unreadable state:** if the state files can't be read, the check returns `state_unavailable` and blocks the send rather than risk mailing a suppressed address.
- **Writing events:** `recordEvent` throws on an unknown event type, an unparseable address, or a missing `STATE_DIR`. Otherwise it creates `STATE_DIR` (and any missing parent directories) if needed. Recording the same event twice does nothing the second time.

**Address handling:** all of these count as the same address:
- Case and surrounding whitespace.
- `Name <<EMAIL>>` and `mailto:` forms.
- A trailing dot on the domain.
- Internationalized domains.
- `+tag` variants.
- Gmail dots and `googlemail.com`.

Unsubscribes and complaints cover every `+tag` variant of an address. Hard bounces cover only the exact mailbox, since a bounce on `a+x@` doesn't prove `a@` is dead. On Gmail, dots and `+tag` don't change the mailbox, so they are treated as one address there.

**Storage:** each event is one small file in `STATE_DIR`, named from the event type and a hash of the address. Each file is fully written and flushed before it appears under its final name, and a second writer of the same event is a harmless no-op. That is why several workers can record at once without locks, and why events survive restarts.

The check does not use `now`. It is accepted for your call signature, and `recordEvent` stores it in the event file.

I didn't add the one-click unsubscribe header (RFC 8058) that Gmail and Yahoo require, or the physical address CAN-SPAM requires in marketing mail. Those belong in the email templates and provider setup, not in this gate.
