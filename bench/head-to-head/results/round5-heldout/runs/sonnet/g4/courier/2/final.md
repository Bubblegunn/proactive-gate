`bot.mjs` is written and passes my checks. Nothing was sent.

**How it works**
- **Storage:** each lead gets its own history file in `STATE_DIR`, which is created if missing. Writes are atomic, so history survives restarts and every worker sees it.
- **Locking:** a per-lead lock makes the check and the claim a single step, so two workers can't both grab the last slot. A lock left behind by a crashed worker is cleared after 30 seconds.
- **Releasing:** the reservation id encodes the lead, so `release` works from any process. Releasing an unknown or already-released id returns `false` and does nothing.
- **Failures:** a missing `STATE_DIR`, bad input or a corrupt history file throws rather than allowing a send. If your sender catches that error and sends anyway, the limiter doesn't protect you.

**Rules I chose**
- **Sliding window:** a slot counts for `windowHours` after it was claimed, then drops off. There is no reset at midnight, so a lead can't get a burst at 23:59 followed by another at 00:01.
- **Released slots:** they count toward neither the cap nor the gap, because the lead never received that message.
- **Denied calls:** they record nothing, so repeated attempts can't push the lead's next allowed time further out.
- **Reason codes:**
  - `min_gap` is checked first.
  - `window_cap` is checked second.
  - A `maxPerWindow` of 0 always returns `window_cap`.
- **Cleanup:** history older than 31 days is pruned. That is a fixed limit, so a campaign with a window longer than 31 days would lose older slots.

**What I tested**
- The 90-minute gap is enforced.
- Releasing a slot frees both the gap and the cap.
- The 3-per-window cap is enforced.
- The window slides once the oldest slot ages out.
- 12 separate processes asked for the same lead at the same moment, and exactly 3 were allowed.

I didn't test the crashed-worker lock cleanup or a corrupt history file.

The test script is `/tmp/courier-test/test.mjs`, outside the repo. I haven't committed anything.
