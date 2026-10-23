I wrote `bot.mjs` and tested it. Nothing was sent, and I didn't use the Courier API, since this is a local check that runs before any send. The tests passed, including one with 6 processes each writing 50 events at the same time (300 events). All 300 were still blocked afterwards, and none were lost or corrupted.

**How it stores state**
- Each event is one JSON line appended to `$STATE_DIR/suppressions.log`.
- The file is flushed to disk on every write, so recorded events survive a restart. Each event is a single append, so several webhook workers can write at once without mixing lines.
- `checkEmail` re-reads the file on every call, so it sees events recorded by other workers. A damaged line is skipped.
- `STATE_DIR` is read on each call, and the directory is created if it's missing.

**How addresses are matched**
- Matching ignores case, surrounding spaces, `Name <<EMAIL>>`, `mailto:`, a trailing dot on the domain, and international domain spelling.
- Gmail and googlemail.com addresses are treated as the same mailbox, with dots and `+tag` ignored.
- For other domains, an unsubscribe or spam complaint also covers `+tag` variants of the address. A hard bounce only applies to the exact address.

**Rules, and the `rule` values returned when `allowed` is false**

| Situation | Marketing | Transactional | `rule` |
|---|---|---|---|
| `hard_bounce` | blocked | blocked | `hard_bounce` |
| `spam_complaint` | blocked | allowed | `spam_complaint` |
| `unsubscribe` | blocked | allowed | `unsubscribed` |
| Address can't be parsed | blocked | blocked | `invalid_address` |
| `kind` is neither value | blocked | blocked | `unknown_kind` |

- Unsubscribes take effect immediately, not after CAN-SPAM's 10 business days.
- I allow transactional mail after an unsubscribe or spam complaint because CAN-SPAM exempts mail the person needs, like password resets. If you'd rather block all mail after a spam complaint, it's one line to change.
- Nothing ever re-subscribes an address, because there is no such event type.
- `recordEvent` throws a `TypeError` for an unknown `type` or an unparseable email.

I didn't implement the one-click unsubscribe headers (`List-Unsubscribe`, `List-Unsubscribe-Post`) that Gmail and Yahoo require for bulk senders. They belong on the outgoing message, not in this check, so the sending code still has to add them.

My test script is in `/tmp/courier-test/`, outside the repo.
