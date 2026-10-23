`bot.mjs` is written and my checks pass, including 8 processes writing at the same time and a fresh process reading the result. Nothing was sent. My test script is `/tmp/t4/test.mjs`, outside the repo.

**What each event blocks**
- **`hard_bounce`:** blocks all mail to that address, marketing and transactional. The rule is `hard_bounce`.
- **`unsubscribe`:** blocks marketing only. The rule is `unsubscribed`.
- **`spam_complaint`:** blocks marketing only. The rule is `spam_complaint`.
- **Both marketing blocks:** a transactional message like a receipt or password reset still goes out. If you also want a spam complaint to block transactional mail, change one condition in `checkEmail`.
- **Permanent records:** nothing lifts a block, because no event type re-subscribes an address.
- **Malformed input:** a bad address returns `allowed: false` with rule `invalid_address`. A `kind` other than the two you named returns `invalid_kind`. `recordEvent` throws on a bad address, type or `now`, so the webhook doesn't silently drop an event.
- **Precedence:** if an address has several records, the rule reported is `hard_bounce`, then `spam_complaint`, then `unsubscribed`.

**Written differently**
The same address is matched across these variations:
- **Case and whitespace:** `Bob@Example.COM` and `  Bob@Example.COM ` match, and so does a trailing dot after the domain.
- **Wrappers:** `Bob <bob@example.com>` and `mailto:bob@example.com` match.
- **Fullwidth and internationalised names:** fullwidth characters are folded to normal ones, and internationalised domain names are converted to their ASCII form.
- **Gmail:** `googlemail.com` counts as `gmail.com`, and dots are ignored in the name, because Gmail ignores them.
- **`+tag` addresses:** an unsubscribe or complaint for `bob+news@example.com` also blocks `bob@example.com`. A hard bounce on `<EMAIL>` does not block `<EMAIL>`, because a different mailbox could still exist. This is my judgement call; say if you want it stricter.

**Storage**
Each record is its own small file in `STATE_DIR`, named from a hash of the address and the event type. Each file is written to a temporary name, flushed to disk, then renamed into place. Writers in different processes can't corrupt anything, and recording the same event twice does nothing. `STATE_DIR` is read on every call, and `recordEvent` creates it if missing.

`now` is only stored as a timestamp in each record.

CAN-SPAM requires honouring opt-outs within 10 business days; this gate blocks the next marketing check immediately. Separately from this gate, make sure marketing emails carry the one-click unsubscribe header that Gmail and Yahoo require.
