I wrote `bot.mjs` in the work directory. Tests pass. Nothing is committed and nothing was sent.

**What it does**
- **State:** one append-only log per address at `STATE_DIR/addresses/<sha256>.log`. Each write is fsynced before the call returns, and the directory is created if missing. Workers share nothing else, so a restarted worker reads the same state.
- **Address matching:** trims and lowercases, so `" Foo@Example.COM "` and `foo@example.com` are the same address. For Gmail (`googlemail.com` is treated as `gmail.com`), dots and `+tags` are also ignored, because they reach the same mailbox.
- **`unsubscribe(email)`:** blocks marketing mail to that address right away. Receipts are not blocked.
- **`resubscribe(email)`:** the only call that lifts the block. It always appends, so a resubscribe cannot be lost to a race with a concurrent unsubscribe.
- **`mayEmail(email, kind, now)`:** a marketing send to an unsubscribed address returns `allowed: false` with a short reason. A receipt returns `allowed: true`. It fails closed: if the log cannot be read, the send is blocked. An invalid address is blocked with a reason. A bad `kind` or `now` throws, and so does a missing `STATE_DIR`.

**Tests**
I ran a scratch test suite outside the work directory. It covered:
- normalization and Gmail variants;
- unsubscribe, resubscribe and re-unsubscribe;
- receipts vs marketing;
- invalid input;
- a torn line left by a killed worker;
- an unreadable log (fails closed);
- 8 separate Node processes writing concurrently to the same addresses, with all records surviving;
- a resubscribe from another process.

All passed. I ran them on Node 24 locally; the code uses only APIs that exist in Node 22.

**Decisions you should check**
1. **EU opt-in is not enforced.** Under GDPR and ePrivacy, marketing to EU customers needs prior opt-in consent. This module has no country and no consent record, so marketing is allowed to anyone who has not unsubscribed. This is the US opt-out model. Compliance for EU recipients needs a consent source and a country or region input. Neither is in the API you specified. Until that exists, I would not send marketing to EU addresses.
2. **Unsubscribe does not block receipts.** I treated receipts as transactional. If "unsubscribe" should mean "stop all mail," change the receipt branch in `mayEmail`.
3. **`now` is validated but does not affect the decision.** An unsubscribe on record applies to every later send. I did not find a rule that needs `now`.
4. **Gmail canonicalization is the only provider-specific rule.** Plus-tags on other providers are not stripped. Stripping them would also block more addresses, which is the safe direction for suppression, so say if you want it.
5. **STATE_DIR must be on a local filesystem.** `O_APPEND` atomicity is not guaranteed on NFS and similar network mounts.
