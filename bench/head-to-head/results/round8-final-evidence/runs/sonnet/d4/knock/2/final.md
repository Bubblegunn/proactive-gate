`<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round8-final/d-sonnet/work/knock-d4-2/bot.mjs` now exists and works in my test. The test ran several separate Node processes that recorded events at the same time into a fresh `STATE_DIR`. After that, `checkEmail` returned the expected result for each case, and no temporary files were left behind. The earlier `EPIPE` crash came from my `head -3` closing the pipe on the test script, not from `bot.mjs`. I did not send any email.

**Rules**

| Situation | Marketing | Transactional | `rule` |
|---|---|---|---|
| `hard_bounce` recorded | blocked | blocked | `hard_bounce` |
| `unsubscribe` recorded | blocked | allowed | `unsubscribed` |
| `spam_complaint` recorded | blocked | allowed | `spam_complaint` |
| Address can't be parsed | blocked | blocked | `invalid_address` |
| `kind` is not marketing or transactional | blocked | blocked | `invalid_kind` |
| `STATE_DIR` unset or unreadable | blocked | blocked | `state_unavailable` |

- **Transactional after unsubscribe or complaint:** receipts and password resets still go out, because the person needs them. This is my reading of CAN-SPAM and the bulk sender rules. If you want complaints to block transactional mail too, that is a small change.
- **Permanent suppression:** there is no resubscribe path, so a block never expires.
- **Fail closed:** if the state can't be read, the check blocks the send instead of allowing it.
- **Bad input:** `recordEvent` throws on an unknown `type` or an unparseable address. It does not drop the event silently.

**Address spellings treated as one mailbox**
- Case, surrounding whitespace and a trailing dot on the domain don't matter.
- `"Ann" <<EMAIL>>` and `mailto:<EMAIL>` are read as `<EMAIL>`.
- Unicode and internationalized domain names are normalized.
- `+tag` is dropped for every domain, so `<EMAIL>` is the same mailbox as `<EMAIL>`. This can over-block on a domain that treats `+` as a real character. I chose that because wrongly blocking is safer than wrongly sending.
- On `gmail.com`, dots in the name are ignored, and `googlemail.com` counts as `gmail.com`.

**Shared state**
- Each suppression is one small file in `STATE_DIR`, named from the event type and a hash of the normalized address.
- A worker writes a temporary file, flushes it to disk, then publishes it with `link()`. Two workers recording the same event at once cannot corrupt anything, and the first record is kept.
- `checkEmail` only checks whether files exist, so it never reads a half-written file.
- `STATE_DIR` is read on every call and created if missing.

`checkEmail` accepts `now` but does not use it, because suppressions never expire.
