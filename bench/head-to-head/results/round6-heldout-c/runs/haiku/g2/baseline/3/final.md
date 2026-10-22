`bot.mjs` is written at `work/baseline-g2-3/bot.mjs`. It exports `decide(candidate, now)`, sends nothing, and all my checks pass.

I checked it with a throwaway script in `/tmp/bot-check/`, which I kept out of the repo. It covers the daily cap, quiet-hour edges, the customer's local day across time zones, DST, and bad input.

Decisions I made that you should confirm:

- **Transactional pushes skip both rules.** They ignore quiet hours and the cap, and they don't count toward the cap. I read "a customer waiting for a courier must still hear about the courier" as covering quiet hours too. A courier or security code at 01:30 should still go out. If you want quiet hours to apply to transactional pushes too, that is a one-line change.
- **Rule order for marketing:** quiet hours are checked first, then the daily cap. A push blocked by quiet hours is not counted, so it does not use up the day's allowance.
- **Quiet window bounds:** start is inclusive and end is exclusive. `start > end` wraps past midnight. `start === end` means no quiet window. The spec did not say what equal times mean, so I chose this.
- **Invalid input throws a `TypeError`.** This covers a bad timezone, a malformed `HH:MM`, an unknown category, and an invalid `now`. I chose throwing over returning a `send: false` result, so a caller bug is not silently logged as a normal block. If you would rather the jobs keep running, the catch belongs in the callers.
- **Counting happens at decision time.** A `send: true` result counts as sent, as the spec asks, even if the caller's provider call later fails.

Memory use is one small entry per user, and only the current local day is kept. `decide` is synchronous, so two jobs in the same process cannot race each other on the count.
