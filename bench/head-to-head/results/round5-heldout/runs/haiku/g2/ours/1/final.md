`bot.mjs` is written at `work/ours-g2-1/bot.mjs`. It exports `createPushGate()`, whose `attempt(user, now)` returns `{ allowed, reason }`. Nothing is sent. The self-check at `/tmp/pg-check/check.mjs` passes. I ran it on Node 24.13, the only version here, and the code uses only features that Node 22 has.

**What each check does**

- **Quiet hours:** the local time is read in `user.timeZone` through `Intl`. The window includes its start minute and excludes its end minute. A window where start is later than end wraps past midnight. Equal start and end means no window. DST is handled by `Intl`, and the check covers a New York spring-forward day.
- **Daily cap:** "per day" means the user's own calendar day in their device zone, not a rolling 24 hours. Only allowed pushes count, so refusals spend nothing. `dailyCap: 0` blocks everything.
- **Held, never guessed:** a missing or unknown zone, a malformed `HH:MM`, a bad cap, an invalid date, or a missing user is refused with its own code.
- **Reason codes:** `quiet_hours`, `daily_cap_reached`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`, `invalid_time`, `invalid_user`. `reason` is `null` when allowed.
- **Independence:** each `createPushGate()` call has its own in-memory history. Settings come from each call.

**Choices you should check**

- I did not use the proactive-gate library. You asked for one file with this export, and the library's persistence and redelivery features don't fit that. The skill's default rules for shared, restart-surviving state and redelivery claims don't apply either, since you said nothing needs to survive a restart and you didn't ask for dedup.
- The gate does not implement opt-out, consent, or STOP handling. Your spec doesn't mention them. Add them if the caller needs them.
- I kept history only for the last four local days per user, to bound memory.
- Your spec didn't say what to do when quiet hours or the cap are missing. I hold the push, because an unknown setting is not a "no".

**Apple and Google guidance this follows:** notifications should be timely and useful, and should not wake people at night or arrive in bulk. Apple's Focus and Android's quiet-hours settings exist for that reason, so the gate honours the user's quiet window and their daily cap.
