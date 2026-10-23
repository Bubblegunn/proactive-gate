`bot.mjs` is written, and the tests I ran against it passed. Nothing was sent.

**How the tests ran**
- They used a temporary `STATE_DIR` and a copy of the file.
- They covered the address spellings, the rules and restart persistence.
- Eight separate Node processes each recorded 60 events at the same moment. Every event was visible afterwards, and no temp files were left behind.

**Rules**
| Recorded event | Marketing | Transactional | `rule` when blocked |
|---|---|---|---|
| `unsubscribe` | blocked | allowed | `unsubscribed` |
| `spam_complaint` | blocked | allowed | `spam_complaint` |
| `hard_bounce` | blocked | blocked | `hard_bounce` |

- **Permanent:** events never expire, because there is no resubscribe event.
- **Other blocks:** an unusable address returns `invalid_address`. An unknown `kind` returns `unknown_kind`. A state-directory read error returns `state_unavailable`, so the check fails closed.

**Different spellings of one address**
- **Normalised:** surrounding whitespace, case, `Name <<EMAIL>>`, `mailto:`, a trailing dot on the domain and unicode domains (`münchen.de` is treated as `xn--mnchen-3ya.de`).
- **Gmail:** dots and `+tags` are ignored, and `googlemail.com` counts as `gmail.com`.
- **Other domains:** a `+tag` is ignored for unsubscribe and spam complaint, so opting out as `<EMAIL>` also blocks `<EMAIL>`. A hard bounce matches only the exact mailbox, because one tagged address not existing doesn't mean the base mailbox doesn't.

**Sharing state between processes**
- Each event is one small file in `STATE_DIR`. It is written to a temp file, synced to disk, then atomically linked to its final name.
- Two workers recording the same event is harmless, and there are no locks or read-modify-write steps.
- `checkEmail` only looks for file existence. `recordEvent` creates `STATE_DIR` if it is missing.

**Your call**
- **Spam complaints:** I let transactional mail through after one, so a person who complained can still get a password reset. If you would rather stop all mail to them, move the `spam_complaint` check in `checkEmail` above the `if (kind === 'marketing')` line.
- **Bad input to `recordEvent`:** an unknown event `type` or an unparseable `email` throws instead of being dropped. The webhook handler should catch that and log it.
