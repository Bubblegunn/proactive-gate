I wrote `bot.mjs` in the work directory and checked it with 13 behavior tests, all passing. The tests ran from a scratch directory outside the project. Nothing was sent and nothing was committed.

**What `decide(candidate, now)` does**

- **Local time:** it converts `now` into the customer's `timezone` with `Intl`, so the caller's server clock doesn't matter.
- **Transactional** pushes always return `{ send: true, rule: null }`. They skip the quiet window and the cap, and they are not counted.
- **Marketing** pushes are checked in this order, and the first hit wins:
  1. `quiet-hours`: the customer's local time is inside `[quietStart, quietEnd)`. Windows that cross midnight are handled.
  2. `daily-cap`: the customer already has 3 sent marketing pushes on their local calendar day.
- Only sent marketing pushes are counted. A push blocked by quiet hours does not use up the day's cap.
- Counts are kept in memory per user and local date. Entries older than two days are pruned on each send, so memory stays bounded. `decide` is synchronous, so the check-and-increment cannot interleave between calls in one Node process.

**Choices you may want to change**

- **Quiet hours apply to marketing only.** The spec says the courier message must get through, so I read the do-not-disturb window as covering marketing only. If you want quiet hours to block security codes too, that is a one-line change.
- **Bad input throws** a `TypeError` (or `RangeError` for an unknown IANA zone) instead of returning `send: false`. A silent block would hide a caller bug.
- **`quietStart === quietEnd`** means no quiet window. The spec doesn't cover this case, so please confirm it.

**Test results:** `node check.mjs` (run from `/tmp/bot-check`) printed `13 checks passed`. The tests cover a midnight-wrapping window, inclusive and exclusive boundaries, the cap resetting at the customer's local midnight rather than UTC, independent zones, transactional bypass, blocked pushes not counting toward the cap, and invalid input.
