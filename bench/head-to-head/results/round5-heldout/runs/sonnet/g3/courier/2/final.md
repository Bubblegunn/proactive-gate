I wrote `bot.mjs`, and the checks I ran passed. Nothing was sent.

**How it works**
- **Storage:** each address gets its own append-only log file in `STATE_DIR`, created if missing. The file name is a hash of the normalized address. Each event is one short line, appended and then fsynced.
- **Workers and restarts:** every worker reads the same files, so any of them can record an event and all of them see it. Restarts lose nothing. I didn't use locks. I expect concurrent appends of one short line each to be safe, and the 8-process test below agreed.
- **Address matching:** the address is trimmed and lowercased, and `Name <<EMAIL>>` and `mailto:` forms are unwrapped. So `Ann <<EMAIL>>` and `<EMAIL>` count as the same person. I did not merge `+tag` variants or Gmail dots.
- **Order of events:** the event with the latest provider time (`at`) decides, not the order events arrived in. A late-arriving old unsubscribe can't override a newer re-subscribe. If an unsubscribe and a re-subscribe have exactly the same time, the unsubscribe wins.
- **Transactional email:** receipts and password resets are always allowed, even for unsubscribed people. CAN-SPAM exempts them.
- **Marketing email:** blocked with `unsubscribed` if the latest event is an unsubscribe. This takes effect immediately, which is stricter than the 10 business days CAN-SPAM allows and in line with Gmail and Yahoo's expectations. Any `kind` other than `transactional` is treated as marketing.
- **Errors:** a marketing message to an unparseable address is blocked with `invalid_address`. If the state can't be read, it is blocked with `state_unreadable`, so a read failure never lets an email through.
- **Bad `at` value:** an invalid `at` is replaced with the current time.
- **Bad address on record:** `recordUnsubscribe` and `recordResubscribe` throw if the address can't be parsed.

**What I checked**
- An unsubscribe blocks marketing for `<EMAIL>` and for case and header variants of it.
- Transactional email to the same address is still allowed.
- A re-subscribe older than the unsubscribe changes nothing, and a newer one re-allows marketing.
- An unsubscribe that arrives late but is older than the re-subscribe doesn't re-block.
- 8 separate processes appended to the same address at once, and all 8 events were recorded and the address ended up blocked.
