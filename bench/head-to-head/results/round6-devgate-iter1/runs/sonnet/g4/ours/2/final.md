`bot.mjs` is written. The checks I ran passed: 12 workers racing, the reason codes, releasing a slot, and the window sliding forward.

**How it works**
- **Shared state:** each lead has one file in `STATE_DIR`, which is read and created on every call. An exclusive lock file guards the file, so only one worker at a time reads and writes a lead's history. Writes go to a temp file and are then renamed. A lock older than 15 seconds is treated as left behind by a crashed worker and removed.
- **Releasing:** the reservation id contains the lead id, so any worker can release it, whether or not it made the reservation. Releasing twice is harmless, and releasing an unknown id returns `false`.

**Limits I chose**
- **Window:** it is rolling, not a calendar day. A slot stops counting exactly `windowHours` after it was reserved, so the lead never gets more than `maxPerWindow` messages in any 24-hour stretch.
- **Gap:** the minimum gap is measured from every active slot. A slot exactly `minGapMinutes` old no longer blocks.
- **Released slots:** they count toward neither the cap nor the gap.
- **When both limits apply:** the reason is `max_per_window_reached`. Otherwise it is `min_gap_not_elapsed`.
- **Bad input:** a missing `userId`, a negative or non-numeric limit, or an invalid `now` returns `allowed: false` with reason `invalid_request`. It does not throw.
- **Cleanup:** slots older than 30 days are dropped.

**Checks**
- 12 processes called `reserve` for the same lead at the same instant with a cap of 3. Exactly 3 were allowed and 9 refused.
- With a cap of 2 and a 90-minute gap, `min_gap_not_elapsed` and `max_per_window_reached` each appeared when expected.
- After `release`, the slot was available again. At 24 hours the first slot had expired from the window.

**Not checked:** a crashed lock holder, restarting a worker mid-write, and clock differences between workers. Slots use each caller's own `now`, so badly skewed clocks would skew the history.

**Not enforced:** quiet hours, consent, STOP handling and recipient time zones. You didn't ask for them, and this module only rate-limits. Run those checks in the caller before `reserve`.
