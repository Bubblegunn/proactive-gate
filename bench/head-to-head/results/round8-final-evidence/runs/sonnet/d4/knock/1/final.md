`bot.mjs` is written and works. I tested it with separate Node processes: six ran at once, and each check ran in a fresh process after the events were recorded. It also exports a `normalizeEmail` helper. No mail was sent.

**What it does**
- **Unsubscribe:** blocks marketing (`rule: "unsubscribed"`). Transactional mail is still allowed.
- **Spam complaint:** blocks marketing (`rule: "spam_complaint"`). Transactional mail is still allowed. This was my choice, since receipts and password resets are mail the person needs. If you want complaints to block transactional mail too, it is one line in the `BLOCKS` table.
- **Hard bounce:** blocks both kinds (`rule: "hard_bounce"`), because the address doesn't exist.
- **Unusable input:** an unparseable address or an unknown `kind` is blocked (`invalid_address`, `invalid_kind`). If the state directory can't be read, the check also blocks (`state_unavailable`). It never sends when it is unsure.
- **Allowed:** returns `{ allowed: true, rule: "" }`.

**Same address, different spellings**
Before storing or checking, an address is made canonical:
- Case, surrounding spaces and invisible characters are removed.
- `Name <<EMAIL>>` and `mailto:` forms are unwrapped.
- Full-width characters, a trailing dot in the domain, and internationalized (non-ASCII) domain names are handled.
- For Gmail, dots and `+tag` are ignored, and `googlemail.com` is treated as `gmail.com`. I did not fold `+tag` for other domains, because they may treat those as separate mailboxes.

**Sharing state between processes**
- Each recorded event is one file in `STATE_DIR`, named from a hash of the canonical address plus the event type.
- Each file is written to a temporary name, synced to disk, then hard-linked into place. Workers recording at the same moment can't corrupt it or overwrite each other, and no locks are needed.
- Recording the same event twice is harmless, and the first timestamp is kept.
- Checks only look for those files, so they are fast and survive restarts.
- `STATE_DIR` is read on each call, and the directory is created if missing.

**Test results**
- Six processes recorded the same Gmail address at once, written four different ways. That gave one clean file.
- `<EMAIL>` and `<EMAIL>` were both blocked for marketing and allowed for transactional.
- The `Bob <BOB@Example.COM.>` spam complaint blocked `bob@example.com` for marketing only.
- `dead@example.org` was blocked for both kinds.
- `ok@example.org` was allowed for both kinds.
- `bad` was rejected as `invalid_address`.
- No leftover temporary files remained.

The `now` argument to `checkEmail` is accepted but not used. Suppression is permanent, so only the recorded time is stored. `recordEvent` throws on an unknown `type`, an invalid `now`, or an unparseable address, so the webhook handler can return an error and the provider will retry.
