`bot.mjs` is written and works. I tested it with a sequential run and with 12 processes at once, and sent nothing.

- **Concurrency:** 12 separate processes all called `reserve` for the same lead with a cap of 3. Exactly 3 were allowed and 9 refused, and no lock files were left behind.
- **Sequential run:** with a cap of 3 and a 90-minute gap, the results were allowed, `min_gap_not_elapsed`, allowed, allowed, `window_limit_reached`.
- **Release:** it returned true the first time and false the second, so releasing twice can't free a second slot. After a release, the slot was available again. I also released a slot from a different process than the one that reserved it, and that worked.

How I chose the behaviour:

- **Rolling window:** the window is measured back from `now`, not by calendar day. A lead can't get a burst of messages just because midnight passed.
- **Counting:** a slot counts from the moment it is reserved, since the send is about to happen. `release` removes it entirely, so a message the provider rejected uses neither the cap nor the gap.
- **Gap:** it is measured from the lead's latest slot. If a worker's clock runs ahead and stamps a slot later than `now`, that slot still counts as recent. Clock skew can't get around the gap.
- **Channels:** WhatsApp and SMS share one history per lead, because the lead sees one stream of messages from you. If you want separate limits per channel, the request would need a channel field.
- **Reason codes:** `min_gap_not_elapsed` and `window_limit_reached`. If both limits apply, the gap code is returned.
- **Limits per call:** each call applies its own limits to the stored history, so campaigns with different settings work.

State is one JSON file per lead in `STATE_DIR`, created if missing. Each file is guarded by a lock file, so workers don't block each other across different leads. A lock held by a dead process, or older than 30 seconds, is taken over. Writes go through a temporary file and a rename, so a crash can't leave a half-written history. A corrupted history file raises an error instead of resetting to empty. History older than 90 days is dropped.

`reserve` throws on invalid input or a missing `STATE_DIR`. It does not fail open, so a misconfigured worker can't send unchecked. `release` of an unknown or malformed id returns false.

My test script is in `/tmp/rl/t.mjs`, outside the project. I did not add a test file to the repo.
