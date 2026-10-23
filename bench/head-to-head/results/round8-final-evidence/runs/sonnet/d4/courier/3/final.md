`bot.mjs` is written in the working directory and passes my checks. The one failure I hit was a bug in my test script, not in `bot.mjs`.

The test ran in a fresh `STATE_DIR` that did not exist beforehand. It checked:
- **Spelling variants:** upper-case letters, a display name with angle brackets, `mailto:`, a trailing dot on the domain, `+tag`, Gmail dots and `googlemail.com`, and an accented domain vs. its punycode form all match the same address.
- **Rules:** each denial reason gives a different `rule` string.
- **Concurrency:** 12 separate Node processes wrote to the same directory at once, some to the same address and some to different ones. All records were present afterwards, with no leftover temp files.
- **Restart:** a fresh process still saw the saved records.

I did not test crash-during-write or a full-disk case.

**How it behaves**
- **Unsubscribe and spam complaint:** these block `marketing` only. `transactional` mail still goes out, since the person needs it and CAN-SPAM exempts it. This is my own policy choice. If you want spam complaints to block receipts and password resets as well, it is a one-line change.
- **Hard bounce:** this blocks both kinds.
- **Opt-outs match loosely.** They strip `+tag` on every domain and ignore dots on Gmail. If one alias unsubscribes, all its variants stop getting marketing mail. This can only reduce marketing mail, never add to it.
- **Bounces match the mailbox.** They ignore `+tag` and dots only on Gmail. A bounce on `<EMAIL>` does not block `<EMAIL>`.

**Rule strings:** `hard_bounce`, `spam_complaint`, `unsubscribed`, `invalid_address`, `invalid_kind` and `state_unavailable`. Allowed gives `''`.

**Storage**
- **One file per address and event type.** Each is written to a temp file, flushed, then hard-linked to its final name. Two workers racing on the same address cannot corrupt anything, and a reader never sees a half-written file. Repeat events for the same address and type are ignored, and the first timestamp is kept.
- **No re-subscribe path.** No event type re-subscribes an address, so an unsubscribe is permanent.

**Failure handling**
- **Unreadable state:** `checkEmail` returns `state_unavailable` and blocks the send, for both kinds.
- **Unparseable address or unknown kind:** `checkEmail` denies the send.
- **Bad input to `recordEvent`:** it throws a `TypeError` for an unknown `type`, an invalid `now`, or an unparseable address. It also throws if `STATE_DIR` is unset. The webhook handler should catch these and return an error status so the provider retries.

I also exported a `normalizeEmail` helper. The test script is in `/tmp/gt/test.mjs`, outside the repo.
