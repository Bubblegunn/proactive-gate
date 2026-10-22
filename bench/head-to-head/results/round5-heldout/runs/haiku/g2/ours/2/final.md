`bot.mjs` is written and passes my self-check. It sends nothing and has no dependencies.

**File:** `work/ours-g2-2/bot.mjs`, exporting `createPushGate()`. Each gate has one method, `attempt(user, now)`, which returns `{ allowed, reason }`.

**Rules, in the order they are checked:**
1. **Bad input** is refused, never guessed: `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`.
2. **Quiet hours** (`quiet_hours`): the window is evaluated in the user's own zone using `Intl`, so DST is handled. The start minute is inside the window and the end minute is outside. A window like 22:00–07:00 wraps past midnight.
3. **Daily cap** (`daily_cap_reached`): counts allowed pushes per user per local calendar day, in the user's zone. Refused attempts don't use up the cap. A cap of 0 blocks every push that day.

**Choices I made that you should check:**
- `quietStart` equal to `quietEnd` means no quiet period, not a 24-hour block.
- Quiet hours are refused outright. The gate does not return a retry time, because the reason has to be a code and you didn't ask for one.
- Counts live only in memory and are per gate, as you specified. A restart clears them, and two processes would each keep their own counts.
- I did not add a minimum gap between pushes. You asked about the daily total and night-time sends, so I left spacing out.
- I did not look up the current Apple or Google notification guidelines, so I can't quote them. I applied the general principles: no sends during sleep hours and a limit on pushes per day.

**Checks run:** a script covering the wrap-around window boundaries, the cap per local day, the day rollover between two instants an hour apart in UTC, DST fall-back in New York, cap 0, all five input-error codes being distinct, and history pruning. It printed "all checks passed". I removed the script afterwards.

I ran it on Node 24.13.0. The code uses only features available in Node 22, but I did not run it on Node 22 itself.
