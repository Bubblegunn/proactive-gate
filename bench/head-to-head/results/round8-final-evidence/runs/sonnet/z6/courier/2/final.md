`bot.mjs` is written and checked. It exports `decide`, `whyNotReceived` and `dryRun`, has no dependencies, and `package.json` is unchanged.

**Checks that passed:**
- **Rules:** I tested the 07:59:59 and 08:00:00 edges, the 22:00 start, the third and fourth notification in a day, and the reset at local midnight. A user without consent never gets anything.
- **Several processes at once:** 6 processes each tried 15 notifications for the same user, 90 in total, and exactly 3 were delivered. A leftover lock from a process killed by an earlier broken test run was cleaned up automatically.
- **Restart:** a fresh process read back the same 90 decisions with 3 delivered.
- **Daylight saving:** a New York cap block on the day the clocks go back reports the next 08:00 local as `2026-11-02T13:00:00.000Z`, which is correct.
- **`dryRun`:** on a hand-made week of events, no quiet hours and no cap delivers 5 of 5. A 22:00–08:00 quiet window with a cap of 2 delivers 2 and blocks 3. It reads and writes nothing in STATE_DIR.

**How it works:**
- **Order of checks:** consent, then quiet hours, then the daily cap, evaluated in the user's local time. Only delivered notifications count toward the cap.
- **State:** each user has an append-only file in `STATE_DIR/users/`, protected by a lock so several workers can share it. Each decision is flushed to disk, and a torn last line from a crash is skipped.
- **Retries:** a repeat of the same notification id for a user returns the original answer and is not counted again. This also means `whyNotReceived` lists each notification once.
- **`whyNotReceived`:** returns decisions in the order they were made, filtered by the decision time. The rule codes are `NO_CONSENT`, `QUIET_HOURS`, `DAILY_CAP` and `INVALID_TIMEZONE`.
- **`availableAt`:** for quiet hours it is the next 08:00 local. For the cap it is the next local day's 08:00. For consent or an invalid timezone it is `null`.
- **`text`:** one sentence in the user's local time that support can read to the customer.

**Choices I made where your spec was silent:**
- A missing or non-`true` consent, or an invalid timezone, blocks the notification rather than throwing.
- In `dryRun`, events are processed in time order regardless of input order. A repeated notification id counts the same as its first occurrence without using up the cap again, so `delivered + blocked` always equals the number of events.
- A quiet window with the same start and end is treated as no quiet hours. A `dailyCap` of 0 blocks everything.

The lock recovery has one rare race I accepted: if two workers both find the same dead lock at the same instant, one can remove the other's fresh lock.

I did not run anything with `git` and made no commit.
