`bot.mjs` is written and passes my concurrency test. The edit to `/tmp/bot-test/test.mjs` was mine: I changed the New York case to use user `u3`.

**How it works**
- Each allowed message claims a numbered slot file for that user and local day. The path is `STATE_DIR/marketing/<sha256 of userId>/<YYYY-MM-DD>/slot-1` or `slot-2`.
- The claim uses exclusive file creation, which is atomic across processes. There is no lock to go stale if a worker crashes, and the count is on disk, so it survives restarts.
- When both slots exist, `reserve` returns `{ allowed: false, rule: "daily-cap" }`. Otherwise it returns `{ allowed: true, rule: "" }`.
- The day is computed from `now` in the user's `timeZone` with `Intl`, so DST is handled and the system clock is never read.
- Each slot file stores the channel and timestamp of the message that took it. That tells you which two messages used the day's allowance, so a held message can be traced.
- Invalid input throws: bad channel, bad `Date`, unknown time zone, or unset `STATE_DIR`. It does not allow by default.

**What I tested**
- 8 separate processes, each making 5 concurrent calls for the same user, allowed exactly 2.
- New processes started afterward were still capped.
- In Tokyo, 23:59:59 stayed in the same day and 00:00 started a new one, with a fresh 2 allowed.
- The same instant in New York counted separately, and a different user was independent.

**Limits**
- A slot is claimed before the send. If a worker crashes after `reserve` but before sending, that slot is still used. This errs toward sending too few messages, never too many.
- Slot files are never deleted. Old days can be removed with a cleanup job.
- The day is part of the path, so one user passed with two different time zones would share a day key. That only matters if a user's zone changes.
