`bot.mjs` is written. I checked it with one inline run, which covered concurrent reserves, the gap and cap limits, and release.

**Behaviour**
- **Counting:** a slot counts from the moment `reserve` allows it. A released slot counts for nothing, so a rejected send costs the lead no budget.
- **Window:** it slides. A slot counts until `windowHours` after its `now`, so there is no midnight reset that would allow a burst at a day boundary. A slot stops counting exactly at its 24-hour mark.
- **Reasons:** `min_gap` or `window_limit`, a different code for each limit. If both limits block, the one that clears later is reported. Bad input returns `invalid_request`.
- **Limits per call:** the limits are read from each call, so they can differ per campaign. The history is shared across them.
- **Shared state:** `STATE_DIR` is read on every call and created if missing. There is one JSON file per lead, written to a temp file and renamed. A lock directory makes each read-modify-write exclusive across processes, and a lock older than 10 seconds is treated as stale.
- **Release:** the reservation id contains the hex-encoded lead id, so any worker can release it. Releasing an unknown or already-released id returns `false` and does nothing.
- **Retention:** records older than 400 days are dropped.

**Check results**
- 12 processes reserved for the same lead at the same instant with a cap of 3. Exactly 3 were allowed and 9 got `window_limit`.
- The first reserve was allowed. A reserve 1 hour later got `min_gap`. One 90 minutes later was allowed.
- Releasing that reservation returned `true`, and a second release returned `false`. The freed slot was reusable.
- A different lead was unaffected.
- My script's labels for the "3rd" and "cap" lines were wrong. The 3rd reserve was correctly refused for `min_gap`, and the reserve I labelled "cap" was correctly allowed. The logic is correct, but the cap-reached case was only exercised by the 12-process run.

**Not checked:** a restart on its own, a crashed lock holder, and clock skew between workers. Skew can cause a wrong block or allow. Each worker's `now` is used as given.

**Assumption:** the request has no message id, so there is no redelivery handling. Two calls for the same lead each take a slot.

**Not enforced:** nothing checks consent, quiet hours or opt-out. That belongs in a gate in front of this limiter.
