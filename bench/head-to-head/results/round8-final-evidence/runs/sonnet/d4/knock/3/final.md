`bot.mjs` is written, and my tests pass. It exports `recordEvent` and `checkEmail`, plus a helper `normalizeEmail`.

**What each event blocks**
- **`unsubscribe`:** blocks marketing, rule `unsubscribed`. Transactional mail is still allowed, as CAN-SPAM permits.
- **`spam_complaint`:** blocks marketing, rule `spam_complaint`. Transactional mail is still allowed. That is my judgement call, so say if you want complaints to block everything.
- **`hard_bounce`:** blocks both kinds, rule `hard_bounce`.
- **Other results:** an unusable address returns `invalid_address`, and an unknown `kind` returns `invalid_kind`. Both are denied. An allowed message returns `{ allowed: true, rule: '' }`.
- **Permanence:** nothing removes a suppression.

**Address matching**
- **Safe variants:** it ignores case and surrounding spaces. It also reads `Name <a@b>`, `mailto:a@b?x=y`, and quoted local parts. It handles a trailing dot on the domain and internationalized domain names.
- **Aggressive folding:** it drops `+tag` suffixes on every domain. For `gmail.com` and `googlemail.com` it also removes dots in the name. A missed match would mean mailing someone who opted out, so I chose this on purpose. The cost is that two genuinely separate mailboxes, such as `<EMAIL>` and `<EMAIL>`, are treated as one.

**Shared state**
- **Marker files:** each suppression is one file in `STATE_DIR`, named from the SHA-256 of the normalized address plus the event type. It is written to a temp file, synced to disk, then hard-linked to its final name.
- **Concurrency:** readers never see a half-written file. Several webhook workers can record the same event at once without a lock, and the first record is kept. State survives restarts because it is only files.
- **Errors:** if `STATE_DIR` is unset, both functions throw rather than guess. A `recordEvent` call with an unknown type or an invalid address also throws.

**Tests** (scratch directory, nothing sent)
- Address variants, the rules above and the Gmail dot rule all gave the expected results.
- Repeating an event is harmless.
- Eight processes recorded events for the same five addresses at once. All five ended up suppressed, with no temp files left in the directory.
- A fresh process read back the state written by earlier processes.
- With `STATE_DIR` unset, `checkEmail` threw instead of allowing the send.

I did not test crash-safety during a write or run any real webhooks.
