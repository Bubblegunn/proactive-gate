`bot.mjs` is written and passes my 17 behavior checks. Nothing was sent, committed, or pushed.

File: `work/baseline-g2-3/bot.mjs`. Exports `createPushGate()`, which returns `{ attempt(user, now) }`.

**Rules, checked in order:**
1. **`quiet_hours`**: the user's local clock time (computed in `user.timeZone`) falls inside `[quietStart, quietEnd)`. If `quietStart > quietEnd`, the window wraps past midnight, so 22:00–07:00 blocks 23:00, 00:30 and 06:59 but allows 07:00.
2. **`daily_cap_reached`**: the user already has `dailyCap` allowed pushes on the same local calendar date in their zone. "Today" is the user's calendar day, not UTC, not the server's day, and not a rolling 24 hours. A 23:30 push in New York and a 00:30 push the next day are two different days.

Only allowed pushes count. A push blocked by quiet hours does not use up the daily cap. Allowed pushes return `reason: null`.

**Choices I made that you may want to change:**
- If `quietStart === quietEnd`, or either bound is missing, quiet hours are off. The alternative would be blocking all day, which seemed wrong.
- I did not add a minimum gap between pushes. Your spec doesn't ask for one, and it would block bursts that the daily cap allows. It's a one-rule addition if you want it.
- Invalid input throws (bad `HH:MM`, negative or non-integer `dailyCap`, invalid `Date`, unknown zone) instead of quietly allowing the push.
- History is in memory and is pruned to 48 hours, which is enough to cover any local calendar day. Memory stays bounded at roughly `2 × dailyCap` entries per user.
- If the clock goes backwards by more than a day between calls, old history may already be pruned, so the cap could be undercounted. I judged that edge case acceptable.

**Verification:** I ran the checks from a scratch directory outside the repo (`/tmp/bot-test/test.mjs`). They cover the cap reset, the zone-based day boundary in New York and Los Angeles, wrapping and non-wrapping quiet hours, a Berlin DST day, per-user isolation, per-call settings, and invalid inputs. The 100k-call run took about 0.7 s. Two test expectations were mine and wrong, and I fixed them before the final run. The code itself didn't need changes.

I did not look up Apple's or Google's notification guidelines (I have no search results from this session). The design follows their general principles: respect quiet times and keep frequency low. I did not quote specific wording from either.
