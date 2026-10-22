`bot.mjs` is written and checked. It exports `reserve` and `release`, uses no dependencies, and I did not send anything.

**Checks run:** a script exercised both functions, including 12 separate processes racing for the same lead.
- A second reservation 30 minutes after the first was refused for the minimum gap.
- A fourth reservation inside the window was refused for the window cap.
- After `release` of one slot, a new reservation was allowed.
- A reservation made after the first one's 24 hours had passed was allowed.
- Of 12 processes racing with a cap of 3, exactly 3 were allowed.

**Behaviour I chose:**
- **Rolling window:** a slot counts for `windowHours` after its reservation time, so a lead never gets more than `maxPerWindow` messages in any 24-hour stretch. A fixed calendar-day window would allow a burst across midnight.
- **Gap and cap apply to the same slots:** a released slot counts toward neither, because the lead never received that message.
- **Refusal codes:** `window_limit_reached`, `min_gap_not_elapsed`, and `invalid_request` for bad input such as a missing `userId` or a negative limit. If both limits would stop a send, the cap code is returned.
- **Caller's limits per call:** each call applies its own limits to the stored history, so campaigns with different settings can share a lead's record.
- **Skewed clocks:** the minimum gap is measured in both directions, so a worker with a clock slightly ahead cannot slip a message in right next to another worker's.
- **Release:** the reservation id contains the lead id, so any worker can release it without a lookup table. Releasing an unknown or already-released id does nothing and returns false.

**State:** `STATE_DIR` is read on every call and created if missing. There is one JSON file per lead. A lock directory makes each reserve or release atomic across processes. A lock left by a crashed worker is broken after 10 seconds. Writes go to a temporary file and are renamed into place. History older than 90 days is dropped on the next reservation for that lead.

**Assumption:** the task gave no consent, quiet-hours or opt-out data, so `bot.mjs` enforces only the frequency limits. Consent and quiet hours need to be checked before `reserve`.
