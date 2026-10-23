`bot.mjs` is written and tested. I'm giving you the summary now.

**What it does.** `decide` returns `{ send: false, reason }` unless every rule below passes. All state is in `STATE_DIR`, one file per user. A per-user lock makes the check and the "delivered" record one atomic step across worker processes. I added no dependencies, so `package.json` is unchanged. I did not use any Courier API: this is a local gate and nothing is sent.

Rules, checked in this order:
1. `flags.proactiveEnabled` must be exactly `true`. A missing flag counts as off.
2. The user has not opted out of this type. `optOut` is permanent for that type.
3. `consents.marketing === true`. Missing or empty consents mean no consent, so nothing is sent. I treated the check-in as a marketing-type message, not a transactional one. Tell me if you want it tied to a different consent purpose.
4. The account is at least 24 hours old. This rule was my call, not in your spec. If you want first-day check-ins, it is one constant.
5. The local time is between 09:00 and 20:00. The zone is `deviceTimezone` if valid, otherwise `timezone`. A missing, invalid, or "UTC" placeholder zone counts as unknown, and then nothing is sent.
6. No recent dismissal of this type. After the 1st, 2nd, 3rd, and 4th or later dismissal, the type pauses for 3, 7, 14, and 30 days. Dismissal history is forgotten after 90 days.
7. Frequency caps: a type is sent at most once per local day and at least 20 hours apart. Any two notifications are at least 3 hours apart. A user gets at most 2 per local day across all types.

Any storage error makes `decide` fail closed (no send, with a reason). The 24-hour, 3-hour, 2-per-day and dismissal-pause numbers are my own choices.

**Checks I ran.** A test script in `/tmp` covered these cases, all passing:
- The kill switch, missing consent, and an opt-out.
- A late-night local time, a placeholder zone with a device zone, and an invalid zone.
- A dismissal pause, a new account, and the once-per-day cap with next-day recovery.

I also ran 20 separate processes at once for the same user: exactly 1 got `send: true`. A later run in a new process got `false`, so the sent record survives a restart.

I did not test the stale-lock recovery path (a worker that dies while holding the lock).
