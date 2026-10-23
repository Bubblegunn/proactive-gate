`bot.mjs` is written and passes my tests. Nothing was sent. I ran the tests on Node 24.13, not Node 22. The test script is `/tmp/gate-test/t.mjs`.

**Rules**
- **`unsubscribe`:** marketing is blocked and transactional is allowed. The rule is `unsubscribed`.
- **`spam_complaint`:** marketing is blocked and transactional is allowed. The rule is `spam_complaint`. This is my choice: receipts and password resets are mail the person still needs. If you want complaints to block everything, it is one line in `checkEmail`.
- **`hard_bounce`:** all mail is blocked, both kinds. The rule is `hard_bounce`.
- **Other rules:** `invalid_address` for an address that can't be parsed, and `invalid_kind` for an unknown `kind`. Both fail closed.
- **Permanence:** records are permanent, and there is no re-subscribe path. `now` is only stored as a timestamp. It does not affect checks, so an opt-out applies immediately.

**Address variants**
- **Normalization:** these all map to one address, so the same address written in different ways is caught:
  - case and surrounding whitespace,
  - `Name <a@b>`,
  - `mailto:`,
  - quoted local parts,
  - a trailing dot on the domain,
  - Unicode and IDN domains (punycode),
  - full-width characters.
- **Opt-outs:** an unsubscribe or complaint for `user+tag@x` also covers `user@x`.
- **Gmail:** Gmail dots, `+tag` and `googlemail.com` are folded together.
- **Bounces:** bounces are matched on the exact mailbox only. A bounce for `user+tag@x` doesn't block `user@x`.
- **Odd addresses in `recordEvent`:** an address that doesn't parse is stored under its lowercased text instead of throwing, so an opt-out is never lost.

**Shared state**
- **Files:** each event is one small file in `STATE_DIR`, named `<sha256(address)>.<type>`. The directory is created if it is missing.
- **Writes:** each write goes to a unique temp file, is fsynced, and is then renamed into place. Rename is atomic, so concurrent webhook workers need no lock and readers never see a partial file. Recording the same event twice is harmless.
- **Reads:** `checkEmail` only checks whether a file exists, so no directory scan or parsing is needed. An unreadable state directory throws instead of allowing the send. A missing one means nothing is suppressed yet.
- **Environment:** `STATE_DIR` is read on each call. If it is unset, both functions throw.

**Checks run**
- All the address-variant cases above.
- The policy for each event type and kind.
- 40 separate processes writing at once, including 10 for the same address.
- A fresh process checking every recorded address afterwards, to mimic a restart.
- No leftover temp files.

The test script is outside your repo directory, so `bot.mjs` is the only new file there.
