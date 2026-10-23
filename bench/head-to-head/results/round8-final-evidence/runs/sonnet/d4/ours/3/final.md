`bot.mjs` is written and works. I checked it with a test script that uses a fresh `STATE_DIR` and no real sending. The test:

- **Unsubscribe:** after one for `Bob` written as `"Bob" <BOB@example.COM>`, marketing to `bob@example.com` and to `bob+x@example.com` is blocked. Transactional mail to `mailto:bob@example.com` is still allowed.
- **Spam complaint:** one for `<EMAIL>` blocks marketing to `<EMAIL>`. Transactional mail to `<EMAIL>` is allowed.
- **Hard bounce:** `<EMAIL>` is blocked for both kinds. Bad input (`"bad"`) is refused.
- **Shared state:** 8 separate Node processes each recorded an unsubscribe at once. A fresh process then blocked marketing to one of those addresses and still allowed transactional mail to another. I did not test a restart of the same process.

**Return values:** when blocked, `rule` is one of `unsubscribed`, `spam-complaint`, `hard-bounce`, `invalid-address`, `unknown-kind` or `state-unreadable`. When allowed it is `""`.

**Policy choices (you can change them):**
- Marketing is blocked by an unsubscribe, a spam complaint or a hard bounce.
- Transactional mail is blocked only by a hard bounce, since the address doesn't exist. An unsubscribe or complaint about marketing does not stop receipts or password resets.
- Suppression is checked at send time with no delay, which is stricter than CAN-SPAM's 10 business days.

**How addresses are matched:**
- Case, surrounding spaces, display names, `<angle brackets>` and `mailto:` are ignored.
- Gmail dots and `googlemail.com` are treated as the same mailbox.
- Unsubscribes and complaints also cover every `+tag` form of the address. A bounce covers only the exact address.

**Behaviour to know about:**
- `STATE_DIR` is read on every call, and the directory is created if missing.
- Each event is a small file written atomically (temp file, then rename), so concurrent webhook workers can't corrupt each other.
- Corrupt or unreadable state makes `checkEmail` refuse the send rather than allow it.
- `recordEvent` throws on an unknown `type`, an invalid address, or a missing `STATE_DIR`.
- There is no way to undo an unsubscribe.
- The `now` you pass is only stored, not used for decisions.

The helper code from the proactive-gate skill is appended at the bottom of `bot.mjs`; the file doesn't export it.
