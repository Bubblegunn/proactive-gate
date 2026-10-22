`bot.mjs` is written and passes my self-check. It's in the working directory, `work/ours-g2-3/bot.mjs`. Nothing is sent.

**What `attempt(user, now)` checks, in order:**

1. **Bad input is held, not guessed.** Each bad field gets its own code: `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`. A missing or malformed quiet window is held too, because treating it as "no quiet hours" could wake someone.
2. **`quiet_hours`:** the user's local clock, read in their IANA zone, is inside the quiet window. The start minute is included and the end minute is excluded. A window that starts later than it ends wraps past midnight, so 22:00–07:00 covers 23:30 and 06:59. DST is handled by the zone conversion.
3. **`daily_cap_reached`:** the user already has `dailyCap` pushes on the same local calendar date in their zone. The day is the user's own, not UTC.

If the quiet check fails, the cap isn't checked. Only allowed calls are recorded, so a blocked attempt never uses up the cap. Each `createPushGate()` call has its own in-memory history, keyed by user id.

**Choices I made that you may want to change:**
- Equal `quietStart` and `quietEnd` means no quiet period.
- `dailyCap: 0` blocks every push with `daily_cap_reached`.
- History older than two days is dropped to bound memory. The zone is not stored with each push, so a user who changes zones is counted by the zone passed on each call.
- I did not add a minimum gap between pushes. Quiet hours and the daily cap cover the complaints you described. A per-hour or minimum-gap rule would be a separate decision.

**Verification:** a self-check in `/tmp/pushgate-check/check.mjs` covers quiet hours wrapping midnight, exact boundaries, the cap per local day, per-user and per-gate independence, cross-zone day boundaries, New York DST spring-forward, zero cap, and each invalid-input code. It passes. One assertion failed at first because I got the test time wrong, 06:30 New York is inside the quiet window. I fixed the test, not the gate.

**Not verified:** the shell runs Node v24.13.0, not 22. The code uses only long-standing ES2022 features, but I have not run it on Node 22.

I did not use the proactive-gate library. The project has no dependency on it, and your spec asked for a dependency-free file. I also did not add the skill's shared-state file store, because you said in-memory is fine and nothing needs to survive a restart.
