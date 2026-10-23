`bot.mjs` is written, and my test script passed. The test used a temporary STATE_DIR and made no real sends.

**Rules**

| Recorded event | Marketing | Transactional |
|---|---|---|
| `hard_bounce` | blocked, rule `hard-bounce` | blocked, rule `hard-bounce` |
| `spam_complaint` | blocked, rule `spam-complaint` | allowed |
| `unsubscribe` | blocked, rule `unsubscribed` | allowed |
| none | allowed, rule `""` | allowed, rule `""` |

- **Invalid addresses:** an address that can't be parsed is blocked for both kinds, with rule `invalid-address`.
- **Unknown kind:** a `kind` other than the two you named is blocked, with rule `unknown-kind`.
- **Unknown event type:** `recordEvent` throws on an unknown `type` or an invalid email, so the webhook handler sees the error.
- **Why transactional passes:** CAN-SPAM lets receipts and password resets go to someone who unsubscribed. After a spam complaint I still allow transactional mail. That is my judgment call. If you want complaints to stop everything, add the same check I use for hard bounces.

**Address matching**
- These forms all map to the same address: surrounding whitespace, quotes, `Name <<EMAIL>>`, a `mailto:` prefix, upper case, a trailing dot on the domain, and internationalized domain names.
- I do not merge `+tag` or Gmail dot variants. `<EMAIL>` and `<EMAIL>` stay separate addresses. Merging them would suppress someone else's real mailbox when only one address bounced.

**Shared state**
- `STATE_DIR` is read on every call and created if missing.
- Each address and event type gets its own file, written to a temporary file, synced to disk and then hard-linked into place. That makes the write atomic, so concurrent webhook workers can't corrupt it or lose an event, and repeated events change nothing.
- Records are permanent, with no expiry. There is no resubscribe function.
- I did not use the skill's helper kit, because this design needs no read-modify-write.

**What the test covered**
- It ran four parallel `recordEvent` calls for the same address.
- Address variants matched each other.
- Each event type produced the expected result for marketing and for transactional mail.
- A clean address, and an invalid one, behaved as listed above.
- I did not run separate OS processes or restart a process. Persistence rests on the files being synced to disk.

`now` is only stored as the time of the event. Nothing expires, so `checkEmail` doesn't use it.
