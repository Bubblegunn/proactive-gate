`bot.mjs` is written. My test run passed: the checks, 8 processes recording in parallel, and a fresh process reading the state afterwards. Nothing was sent.

**Rules**

| Event recorded | Marketing | Transactional | `rule` |
|---|---|---|---|
| `unsubscribe` | blocked | allowed | `unsubscribed` |
| `spam_complaint` | blocked | allowed | `spam_complaint` |
| `hard_bounce` | blocked | blocked | `hard_bounce` |

- **Bad input:** `checkEmail` returns `invalid_address` for a malformed address and `invalid_kind` for an unknown `kind`.
- **Unreadable state:** if `STATE_DIR` is unset or can't be read, it returns `allowed: false` with `state_unavailable`, so a worker never sends on a failed check.
- **Recording errors:** `recordEvent` throws on a bad type, address or `now`, and when `STATE_DIR` is unset.
- **Clock differences:** a recorded event applies regardless of `now`, so clock differences between workers can't let a message through.

**Why transactional mail still goes after an unsubscribe or complaint:** CAN-SPAM covers marketing mail, and receipts and password resets are mail the person needs. If you want complaints to block everything, the change is one line in `checkEmail`.

**Same address written differently:** the address is cleaned up before any check or record.
- It is lowercased and trimmed.
- `Name <<EMAIL>>`, `mailto:` and a trailing dot on the domain are removed.
- Unicode domains are converted, so `bücher.de` matches `xn--bcher-kva.de`.
- `googlemail.com` is treated as `gmail.com`, and Gmail dots and `+tag` are ignored.
- For unsubscribes and complaints, `+tag` is ignored on every domain. That way `<EMAIL>` can't get around an opt-out recorded for `<EMAIL>`.
- A hard bounce applies to the exact mailbox only, because `a+x@` bouncing says nothing about `a@`.

**How state is shared:** each event is one small file in `STATE_DIR`, named from the event type and a hash of the address. The file is fully written and synced, then linked into place, so a reader never sees a half-written file. Parallel webhook workers need no lock, and recording the same event twice is harmless. Events stay recorded across restarts. There is no way to remove an unsubscribe; that would be a delete of the file.

I didn't save my test script into the project. It was in `/tmp/gt/t.mjs`.
