`bot.mjs` is written in the work directory and passes my test suite. Nothing was sent.

**Courier:** I checked the Courier skill first. Its frequency-cap guidance applies to sends through Courier's own platform. Your spec is a local gate that runs before the worker sends, with state in `STATE_DIR`, so I built it locally and didn't use Courier.

**How it works**
- Each customer has their own state file, named by a SHA-256 hash of `userId`, so arbitrary IDs are safe as filenames. Customers don't share files or locks.
- Each call takes a per-customer lock (`mkdir`, which is atomic), reads the sends from the last 24 hours, and decides. An allowed send is appended before the lock is released. A refused call writes nothing new.
- The state file is replaced atomically (write to temp file, fsync, rename), so a crash leaves either the old or the new state.
- The window is the stricter reading: a new send is refused when 5 sends already fall in `[now − 24h, now]`. So 5 sends spanning exactly 24 hours also count.
- `retryAt` is the oldest blocking send plus 24h plus 1 ms. Calling at `retryAt − 1 ms` is refused, and at `retryAt` it is allowed. The test checks both.
- Invalid `userId`, `channel` or `now` throws a `TypeError`. A missing `STATE_DIR` throws. If the lock can't be taken within 15 s, the call throws, so the worker fails closed and doesn't send.

**Tests** (`/tmp/bot-test/test.mjs`, outside the repo)
- Mixed-channel limit, refusal reason, and `retryAt` boundaries.
- Refused calls don't count.
- Other customers are unaffected.
- Odd `userId` values work.
- Argument validation.
- 20 concurrent calls in one process: exactly 5 allowed.
- 8 separate OS processes × 10 calls for the same customer: exactly 5 allowed in total.
- A fresh process after the others sees the stored sends and refuses.

**Caveats**
- I ran everything on Node 24.13, because that's what's installed here. The code uses only standard `node:fs/promises`, `node:crypto` and `node:path` APIs, but I haven't run it on Node 22.
- A lock held for more than 10 s is treated as stale and broken. Two workers breaking the same stale lock at the same instant could, in theory, interfere. I think this is rare enough to accept, but it's a known gap.
- `STATE_DIR` has to be a local filesystem. I haven't tested network mounts, where `mkdir` and `rename` may not be atomic.
- Clock skew between workers can make the window count slightly off. Sends stored with a future timestamp are counted, which errs on the side of refusing.
- Nothing is committed.

Files are in `<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round6-heldout-c-haiku/work/courier-inv-g4-1/`: `bot.mjs`.
