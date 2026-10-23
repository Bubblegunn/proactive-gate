`bot.mjs` is written in the project folder and all my checks pass. It uses only Node built-ins, so `package.json` is unchanged and nothing needed installing. I used the skill's rule order: consent, then quiet hours, then the daily cap.

**`decide`**
- It blocks when the user has no consent (`consent !== true`). It then blocks between 22:00 and 08:00 in the user's local time; 22:00 itself is blocked and 08:00 is allowed. It then blocks once 3 notifications were already delivered on that local calendar day.
- It uses the IANA timezone, so DST is handled. Blocked notifications don't count toward the cap.
- If the timezone is invalid, it fails closed with `invalid_timezone`. You didn't ask for this.
- If a notification id was already delivered, a retry returns `send: true` again and isn't counted twice. You didn't specify this, so say if you want retries handled differently.

**`whyNotReceived`**
- Every decision, delivered or blocked, is saved with its rule code, an `availableAt` time and a plain-language sentence. The sentence includes the user's local time.
- Rule codes are `no_consent`, `quiet_hours`, `daily_cap` and `invalid_timezone`.
- `availableAt` is the next 08:00 local time for `quiet_hours` and `daily_cap`. For `no_consent` and `invalid_timezone` it is `null`, because it can't be known.
- The range is `from` inclusive, `to` exclusive, in the order the decisions were made.
- If a blocked notification is retried later, the retry gets its own new entry.

**`dryRun`**
- It replays last week's events in time order against the candidate policy. It never reads or writes `STATE_DIR`.
- A `null` quiet-hours or cap setting means that rule is off. Consent is still enforced.
- A quiet-hours window with equal start and end is treated as no quiet hours. That is my choice, not something you specified.

**State**
- Each user has a log file under `STATE_DIR/users/`, which is created if it doesn't exist and kept across restarts.
- Each user's file is locked while a decision is made. The lock is cleared if its owning process has died.

**What I ran:**
- Quiet-hours boundaries and the cap, including that it resets at local midnight rather than UTC midnight.
- The no-consent case and retries.
- `whyNotReceived` output, range boundaries and the New York DST fall-back.
- `dryRun` results, with the state files unchanged afterwards.
- 8 separate processes making 80 decisions for one user on one day: exactly 3 were delivered.
- A fresh process afterwards that still saw the cap.

I wrote the test script in `/tmp/gt/test.mjs`, outside the project. I haven't tried two machines sharing one `STATE_DIR` over a network drive; the locking assumes one host.
