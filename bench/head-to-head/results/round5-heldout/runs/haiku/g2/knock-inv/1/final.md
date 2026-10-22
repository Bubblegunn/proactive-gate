Wrote `bot.mjs` in the work directory. All 14 behavior checks pass. Nothing was sent and nothing was committed.

**What the gate does**

- **Night:** if `now` falls inside the user's quiet window (in their `timeZone`), it returns `quiet_hours`. Windows that cross midnight work (22:00–07:00). The end time is exclusive, so 07:00 is allowed. Quiet hours are checked first, so a push that would wake someone is never allowed, even when the daily cap is also hit.
- **Day:** `dailyCap` counts allowed pushes on the user's calendar day in their own zone. The day resets at local midnight, not at UTC midnight or 24 hours after the first push. Over the cap it returns `daily_cap_reached`.
- **Blocked calls** are not counted. Only allowed pushes go into the history.
- **Users are independent.** Each `createPushGate()` call has its own history. Settings are read from each call.

**Choices I made that you may want to change**

- If `quietStart` or `quietEnd` is missing, the gate uses 22:00–07:00 local time. This overrides a user who turned quiet hours off, so drop the default if that is not what you want.
- If `quietStart` equals `quietEnd`, the window is empty and nothing is quiet.
- Invalid input throws: a bad HH:MM, a `dailyCap` that is not a non-negative integer, or an unknown time zone. It does not return a reason code, since those are for rule decisions only.
- I did not add a minimum gap between pushes. Quiet hours and the daily cap address your two complaints. A spacing rule would be a separate product decision.
- The Knock skill says to treat quiet hours as a conditional delay and to apply frequency caps. I followed that. I did not fetch Apple's or Google's current notification guidelines, so the "don't annoy people" part is based on general principles, not their exact text.

**Verification**

I ran `/tmp/push-gate-check/check.mjs` from outside the repo. It covers the quiet-window edges, the cap, the local-midnight reset (Tokyo, where UTC and local dates differ), blocked calls not counting, per-user isolation, per-call settings, a same-day quiet window, the default quiet window, a US DST start, and the invalid-input throws. Three of my own test expectations were wrong at first. I fixed those in the test file; the gate itself did not need changes.
