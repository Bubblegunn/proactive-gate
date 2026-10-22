`bot.mjs` is written and works. I tested it with a throw-away `STATE_DIR` and a fresh Node process, and nothing was sent.

**Rules**
- **Transactional mail** (receipts, password resets) is always allowed, even to someone who unsubscribed. CAN-SPAM exempts it, and those people still expect it.
- **Marketing mail** is blocked with reason `unsubscribed` if the person's latest event is an unsubscribe. This includes the agent's "we miss you" emails.
- **Any other `kind`**, or a missing one, is treated as marketing, so it can't slip past an opt-out.
- **An unparseable marketing address** is blocked with reason `invalid_address`.
- The opt-out takes effect immediately, which is well inside CAN-SPAM's 10-business-day limit.

**Out-of-order events**
- The event with the latest provider time (`at`) wins, regardless of arrival order.
- If an unsubscribe and a resubscribe have exactly the same time, the unsubscribe wins.

**Addresses**
- `"Bob <<EMAIL>>"`, `mailto:` prefixes, surrounding whitespace and capital letters all resolve to the same address.
- I did not strip `+tag` suffixes or Gmail dots, because those can be different mailboxes.

**Sharing across workers**
- Each event is saved as its own small file under `$STATE_DIR/events/<hash of address>/`. It is written under a temporary name, flushed to disk, then renamed into place.
- Workers never overwrite each other and never see half-written files, and no lock is needed. State survives restarts.

**What I checked**
- A new address is allowed.
- After an unsubscribe, marketing is blocked and transactional is still allowed.
- A late-arriving older resubscribe does not override a newer unsubscribe.
- A newer resubscribe re-allows marketing.
- A late-arriving older unsubscribe does not override a newer resubscribe.
- The unsubscribe state was still in force in a fresh process.

I did not run concurrent workers against the same directory. Events are only added, never rewritten, so I expect no conflicts.
