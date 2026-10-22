`bot.mjs` is written and passes my checks. I sent no emails. The checks were a throw-away script that used a temporary `STATE_DIR` that didn't exist yet. I used the Knock skill's CAN-SPAM notes and its transactional vs. marketing categories as a guide.

**Rules**
- **Marketing and "we miss you" mail:** `mayEmail` returns `{allowed:false, reason:"unsubscribed"}` while the address is unsubscribed.
- **Anything not clearly transactional:** it is treated as marketing, so a missing or odd `kind` can't get past an opt-out.
- **Receipts and password resets:** these are always allowed, even after an unsubscribe. CAN-SPAM doesn't treat them as commercial mail, and people expect to still get them.
- **Resubscribe:** a resubscribe lifts the block only if its `at` is later than the latest unsubscribe.
- **Late or out-of-order events:** they are ordered by the provider's time `at`, not by arrival order. A late-arriving old unsubscribe doesn't undo a newer resubscribe, and an old resubscribe doesn't undo a newer unsubscribe.
- **Ties:** if both events have the same `at`, the unsubscribe wins.
- **Address matching:** addresses are normalized, so `Bob <<EMAIL>>`, `mailto:<EMAIL>` and ` <EMAIL> ` all match `<EMAIL>`.
- **Plus-tags and dots:** they are not merged. `<EMAIL>` and `<EMAIL>` count as different addresses.

**Sharing across workers and restarts**
- **Storage:** each address gets one file in `STATE_DIR`, named by a hash of the normalized address. The directory is created if it doesn't exist.
- **Writes:** each event is one appended line, flushed to disk. The shared file is why a click on any worker is seen by all of them.
- **No locks:** workers don't need to coordinate. Nothing is held in memory, so a restart loses nothing.

**Failure behavior**
- **Unreadable state:** if the state for an address can't be read, marketing is blocked with `opt_out_state_unavailable`. Transactional mail still goes out.
- **Bad timestamp:** an unsubscribe with an invalid `at` is still honored and stamped with the current time. A resubscribe with an invalid `at` throws, so it can't lift a block by mistake.

**What I tested**
- **Unsubscribe and resubscribe ordering:** old events are ignored and ties go to the unsubscribe.
- **Transactional mail:** it is not blocked by an opt-out.
- **Concurrency:** 8 separate processes each recorded 20 unsubscribes at once. All 8 addresses ended up blocked.

This module only decides whether a message may go out. Every marketing email still needs a working unsubscribe link, your physical mailing address, and a one-click unsubscribe header, which Gmail and Yahoo require.
