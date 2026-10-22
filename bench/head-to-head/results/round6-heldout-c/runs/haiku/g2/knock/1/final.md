I wrote `bot.mjs` with `decide(candidate, now)` and a test file, `bot.test.mjs`. All 8 tests pass on Node 24.0 (the sandbox has Node 24, not 22; the code only uses APIs that Node 22 has). Nothing is sent.

**How it decides**

1. **Transactional:** always returns `{ send: true, rule: null }`. It skips quiet hours and the cap, and it is not counted.
2. **Marketing inside the customer's quiet window:** returns `rule: "quiet-hours"`. The window is checked in the customer's timezone and can wrap past midnight. The end time is exclusive.
3. **Marketing with 3 sends already today:** returns `rule: "daily-cap"`. The day is the customer's local calendar day.
4. **Otherwise:** returns `{ send: true, rule: null }` and adds 1 to that customer's count for that local day.

A blocked push never uses up a cap slot. State is a `Map` keyed by `userId|YYYY-MM-DD`, and entries older than 3 days are pruned on each send. Calls are synchronous, so the check-and-increment cannot interleave.

**Choices you should confirm**

- **Quiet hours do not apply to transactional pushes.** Your brief says a courier update must still get through, so I read that as an exemption from quiet hours too. If quiet hours should also stop security codes at night, that is a one-line change.
- **When both rules would block, `quiet-hours` wins.** Logs will show one rule, and the cap is not charged.
- **`quietStart` equal to `quietEnd` means no quiet window.** The brief did not cover this case, so I chose the reading that does not silence a customer all day.
- **Bad input throws.** An unknown category, a malformed `HH:MM`, an invalid `Date`, or an unknown IANA zone raises an error. It does not return `send: false`, so the caller sees the bug.

**Tests** (`node --test bot.test.mjs`) cover: transactional bypass; the 3-per-day cap; the cap resetting at the customer's local midnight and not UTC midnight; a midnight-wrapping quiet window; a New York customer checked against the UTC clock; quiet-hours blocks not using up the cap; the cap being per customer; and input validation.
