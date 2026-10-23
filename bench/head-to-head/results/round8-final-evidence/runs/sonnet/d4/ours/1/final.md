`bot.mjs` is written and works. I tested it with a script that exercised each case below. I also checked that a fresh process still sees the earlier unsubscribe. I did not test several workers recording at once through separate processes. The only concurrency check was six overlapping `recordEvent` calls in one process.

**Rules**

| Case | marketing | transactional | `rule` |
|---|---|---|---|
| no record | allowed | allowed | `""` |
| `unsubscribe` | blocked | allowed | `unsubscribed` |
| `spam_complaint` | blocked | allowed | `spam-complaint` |
| `hard_bounce` | blocked | blocked | `hard-bounce` |
| unparseable address | blocked | blocked | `invalid-address` |
| `kind` not marketing/transactional | blocked | blocked | `invalid-kind` |

- **Transactional mail:** I let receipts and password resets through after an unsubscribe or a spam complaint, because CAN-SPAM only covers commercial mail. A hard bounce blocks everything, since the address doesn't exist.
- **Permanent records:** Nothing expires and there is no re-subscribe event. A repeated webhook keeps the earliest record.
- **Several events for one address:** The reason reported is hard bounce first, then spam complaint, then unsubscribe.

**Address forms treated as the same mailbox**
- Case, surrounding spaces and Unicode forms.
- `Name <<EMAIL>>` and `mailto:<EMAIL>`.
- A trailing dot after the domain, and international domain names.
- `+tag` suffixes.
- For Gmail, dots in the name and `googlemail.com`.

Stripping `+tag` means an unsubscribe for `<EMAIL>` also blocks `<EMAIL>`. I chose that so one person can't get around an opt-out by changing the tag. It can over-block if a domain treats tagged names as different mailboxes.

**Shared state**
- State is one file per event type and address in `STATE_DIR`. I included the skill's helper functions from `proactive-gate` at the end of `bot.mjs`, and the files are written through them atomically.
- `STATE_DIR` is read and created on every call.
- Each file name is a hash of the address, so no raw email is in a filename.
- `recordEvent` throws on an unknown `type` or an unparseable `email`, so your webhook handler can return an error and the provider retries.

**Not checked:** I did not look for a List-Unsubscribe header, an unsubscribe link or a postal address in the message. Those are required by CAN-SPAM and by Gmail and Yahoo, but they apply to the message body and headers, and this gate never sees those. Also not enforced: one-click unsubscribe, the Gmail/Yahoo spam-rate threshold (0.3%), and the 10-business-day limit for honoring an unsubscribe. The gate honors an unsubscribe immediately once it is recorded.

I chose no numbers such as caps or time limits.
