`bot.mjs` is written and its tests pass. I also added `bot.test.mjs` to check it. Nothing was sent, and I did not commit.

**How it works**
- Each customer has one state file, `STATE_DIR/users/<sha256(userId)>.json`, holding `{ sent: [{ at, channel }] }`. Hashing the id keeps odd ids out of file paths.
- Each call takes a per-customer lock (`STATE_DIR/locks/<hash>.lock`, created with `mkdir`, which is atomic). It reads the list, decides, writes the list back through a temp file plus fsync and rename, then releases the lock. Two workers hitting the same customer are serialized. Other customers have their own locks.
- The window is the 24 hours ending at `now`, so an entry at time `t` counts while `t > now − 24h`. The sends in the window are sorted. If there are fewer than 5, the call is allowed and its timestamp is stored. If there are 5 or more, `retryAt` is the 24-hour mark of the oldest send in the window. Blocked calls store nothing.
- Entries older than 25 hours are pruned. The extra hour lets a caller with a slightly slower clock still see the entries it needs.
- Channels are not limited separately. All three channels count toward the same 5.

**Choices I made that you may want to change**
- Invalid `userId`, `channel` or `now` throws a `TypeError`. A corrupt state file also throws. Both reject rather than allow, so a worker never sends on bad state.
- If a lock cannot be taken within 10 seconds, the call throws. It does not allow.
- A lock older than 10 seconds is treated as left by a crashed process and is removed. The critical section takes milliseconds. A process stalled for over 10 seconds inside it could let another process in. That risk is small but not zero.
- `reason` is one sentence giving the limit, the customer's count, and the next allowed time in ISO form. It does not include the customer id.

**Verification**
- `node --test bot.test.mjs` passed 10/10 on Node v24.13.0 (locally). I ran it four times with no failures. I did not run it on Node 22; the code uses only `node:fs/promises` and `node:crypto` APIs that Node 22 has.
- The tests cover the 5-then-blocked case, retryAt exact to the millisecond, the sliding window, mixed channels, customer isolation, state surviving a restart in a new process, hostile ids, invalid input, corrupt files, and 10 processes × 4 attempts on one customer, which allowed exactly 5.
- Not covered by tests: the stale-lock recovery path.
