`bot.mjs` is written and tested. Nothing was sent. My checks passed: address matching, the per-kind rules, and 20 separate Node processes writing events at once. After those writes, a fresh process still blocked the address.

**Rules returned when `allowed` is false**
- `unsubscribed`, `spam_complaint` and `hard_bounce`: the stored reason. Marketing checks them in the order hard bounce, spam complaint, unsubscribe.
- `invalid_kind` and `invalid_address`: the input is bad.
- `state_unavailable`: `STATE_DIR` is unset or unreadable. It fails closed, so nothing goes out when the check can't run.

**Policy**
- **Marketing:** blocked by an unsubscribe, a spam complaint or a hard bounce. An unsubscribe takes effect immediately, well inside CAN-SPAM's 10 days.
- **Transactional:** blocked only by a hard bounce. CAN-SPAM exempts transactional mail from unsubscribes. I also let transactional mail through after a spam complaint, treating the complaint as a marketing opt-out. If you would rather stop all mail after a complaint, change the `blocking` list in `checkEmail`.

**Address variants**
- **Normalised for every event:** case, whitespace, `Name <addr>`, `mailto:`, a trailing dot on the domain, and Unicode domains.
- **Unsubscribe and spam complaint:** apply to every `+tag` variant, and at Gmail also to dots and `googlemail.com`. The person opted out, not one alias.
- **Hard bounce:** applies to the exact mailbox, `+tag` included, because another alias of that address may still exist.

**Sharing state between processes**
- State lives under `$STATE_DIR/suppression/`, with one small file per address and event type.
- Each file is written to a temp file, flushed to disk, then hard-linked into place. The link is atomic, so there are no partial files and no lost updates, and no locks are needed.
- Files are never deleted, so a suppression survives restarts. A repeated event keeps the first timestamp.
- `recordEvent` throws on an unknown `type` or an unparseable email, so the webhook handler can see and log it.

I didn't add a way to re-subscribe someone. Reversing a suppression means deleting its file by hand.
