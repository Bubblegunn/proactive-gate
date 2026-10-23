`bot.mjs` is written and passes my tests: normal checks, 20 parallel writer processes, and a fresh process reading the saved state. The test script is `/tmp/bt/test.mjs`, outside your repo. Nothing was sent.

**Rules**

| Recorded event | `marketing` | `transactional` | `rule` when blocked |
|---|---|---|---|
| `hard_bounce` | blocked | blocked | `hard_bounce` |
| `spam_complaint` | blocked | allowed | `spam_complaint` |
| `unsubscribe` | blocked | allowed | `unsubscribed` |

- **Never allowed:** an unparseable address returns `invalid_address`. An unknown `kind` returns `invalid_kind`.
- **Permanent:** unsubscribes and complaints stay in effect. Nothing in the API removes them.
- **Check failures:** if `STATE_DIR` is unset, or a state file can't be read for any reason except "not found", `checkEmail` throws. It never guesses "allowed".

**Addresses written differently**
- **Spelling:** case, surrounding spaces, `Name <<EMAIL>>`, `mailto:`, a trailing dot on the domain, Unicode look-alike characters, and internationalised domains all map to the same address.
- **Gmail:** `googlemail.com` is treated as `gmail.com`, and dots and `+tag` are ignored.
- **Opt-outs ignore `+tag` everywhere:** an unsubscribe or complaint for `<EMAIL>` also blocks `<EMAIL>` and `<EMAIL>`. This can block slightly more than needed, which is the safer direction for CAN-SPAM.
- **Bounces:** these match the exact mailbox. A bounce for `<EMAIL>` does not block `<EMAIL>`, except on Gmail, where they are the same mailbox.

**Shared state**
- **Files:** each address and event type gets one small file in `STATE_DIR`, named from a hash of the address. Writers just append, so several webhook workers can write at once without locks.
- **Existence check:** a check only tests whether the file exists, so it can never read half-written data.
- **Durability:** each write is flushed to disk (file and directory) before `recordEvent` resolves.
- **Setup:** `STATE_DIR` is created if it doesn't exist.

**Behaviors to know about**
- **Bad input to `recordEvent`:** it throws on an unknown `type` or an unparseable `email`. The webhook handler must catch this and decide what to do, because that address can't be suppressed.
- **`now`:** it is only stored as a timestamp in the event record. It does not affect any decision, so `checkEmail` ignores its `now`.
- **Transactional mail after a spam complaint:** I chose to allow it, since the person needs receipts and password resets. If you'd rather block all mail after a complaint, it's a one-line change.
