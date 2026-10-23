`bot.mjs` is written and passes my checks. The test sent no email.

The checks covered the main paths:
- **Normalization:** the same address written in different ways is treated as one.
- **Rules:** each blocking reason returns its own rule identifier.
- **Concurrency:** six processes recorded events at once, with the same address recorded in all of them.
- **Restart:** a separate new process then saw every recorded event.

**What it blocks**

| Event | Marketing | Transactional | Rule |
|---|---|---|---|
| `hard_bounce` | blocked | blocked | `hard-bounce` |
| `spam_complaint` | blocked | allowed | `spam-complaint` |
| `unsubscribe` | blocked | allowed | `unsubscribed` |

- **Other denials:** an unparseable address returns `invalid-address`, and an unknown `kind` returns `invalid-kind`. Both fail closed.
- **Bad input to `recordEvent`:** an unknown `type` or an invalid address throws.
- **Permanent suppression:** there is no resubscribe event, so a block never expires. A late webhook still blocks.

**Address normalization**
- Whitespace, letter case, `Name <<EMAIL>>`, `mailto:` and a trailing dot on the domain are removed or lowercased.
- Internationalized domains are converted to ASCII.
- A `+tag` is dropped, because it delivers to the same mailbox.
- For Gmail, dots in the name are ignored and `googlemail.com` is treated as `gmail.com`.
- One side effect: `<EMAIL>` and `<EMAIL>` count as the same person on every domain. I chose this so a suppression can't be dodged by changing the tag.

**Shared state**
- Each address and event type gets one small file in `STATE_DIR`, named by a hash of the normalized address.
- A file is written fully, synced to disk, then published atomically. The first record wins.
- There are no locks, so concurrent webhook workers can't corrupt anything. `STATE_DIR` is created if it is missing.

**Decision for you:** I allow transactional mail after a spam complaint, since receipts and password resets are mail the person needs. If you would rather stop all mail after a complaint, move `'transactional'` into the `spam_complaint` entry's `kinds` list in `BLOCKS`.

The test script is at `/tmp/botcheck/check.mjs`. It sits outside the repo.
