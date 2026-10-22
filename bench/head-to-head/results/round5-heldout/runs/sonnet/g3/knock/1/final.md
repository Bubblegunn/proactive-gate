Ik wrote `bot.mjs` and tested it. Nothing was sent. The checks used a throw-away `STATE_DIR`, and I did not test two workers writing at the same moment.

- **Unsubscribed addresses:** `mayEmail` returns `{ allowed: false, reason: "unsubscribed" }` for marketing mail to an address that has opted out.
- **Transactional mail:** order receipts and password resets are always allowed, as CAN-SPAM permits.
- **Unknown `kind`:** anything that isn't exactly `"transactional"` is treated as marketing.
- **Address matching:** addresses are compared after trimming and lowercasing. `Ann Lee <ann@example.COM>`, `mailto:` forms and `" ann@example.com "` all match the same person.
- **Shared storage:** each address gets its own log file under `STATE_DIR/optout/`, and each event is appended and synced to disk before the call returns. Workers share state through those files, so a restart loses nothing and the log files need no locking.
- **Late or out-of-order events:** the newest event by the provider's time (`at`) decides. An unsubscribe that arrives late but is older than a resubscribe doesn't undo the resubscribe. On an exact tie, the unsubscribe wins.
- **Invalid `at`:** an unsubscribe with an unusable `at` is recorded at the current time, so an opt-out is never lost. A resubscribe with an unusable `at` throws an error, because guessing a time could override a real unsubscribe.
- **`STATE_DIR`:** it is read on each call, and `bot.mjs` creates the directory if it doesn't exist.
- **Check run:** the sequence was marketing allowed, then unsubscribed and blocked, transactional still allowed, resubscribed and allowed, then a late older unsubscribe that is correctly ignored. A newer unsubscribe then blocked again. A separate Node process then read the same state and returned the same result.

Plus-addressing is not collapsed: `<EMAIL>` and `<EMAIL>` count as different people.
