I wrote `bot.mjs` with `checkSms(user, now)`, plus `bot.test.mjs`. All 11 tests pass, including under three machine time zones. Nothing was sent and nothing was committed.

**The rule:** a text may go out only between 08:00 (inclusive) and 21:00 (exclusive) on the patient's local clock, computed in their IANA zone. Outside that window the result is held, and `nextAllowedAt` is the next 08:00 local.

**Choices I made that you should check:**
- **No time zone (null, empty, or unrecognised):** held, with `nextAllowedAt: null`. I can't tell when the window is open, so I didn't guess a zone. This means those reminders stay blocked until someone fixes the patient's zone. If you'd rather fall back to a default zone, say so.
- **Malformed phone** (not `+` followed by 7–15 digits): held, with `nextAllowedAt: null`.
- **Invalid `now` or a non-object `user`:** throws a `TypeError`. The scheduler should treat that as a failed check, not as a send.
- **Half-hour zones** such as Asia/Kolkata are handled by the same code path.
- **Stateless:** the function keeps no per-patient history, so it cannot enforce a frequency cap. The input you specified doesn't include send history.

**Verification:**
- Fixed cases cover the 08:00 and 21:00 edges, a half-hour zone, DST fall-back and spring-forward days, and month rollover.
- A property test sweeps 11 zones across all of 2026. For every held result it checks that `nextAllowedAt` is in the future, that the check passes at that instant, and that it fails 1 ms earlier. So the retry time is never too early.
- The tests also pass with `TZ` set to Asia/Tokyo, Pacific/Kiritimati, and America/Chicago, so the machine zone doesn't affect results.
- I ran the code under Node v24.13.0 (`node --test`); it uses only APIs that exist in Node 22.

**What this does not cover:** the complaint you mentioned is probably about consent, and this gate can't check that. The input you specified has no opt-in or STOP/unsubscribe field. Before the first send, you need an opt-in check in the scheduler, or a new input field. US texting rules (TCPA) require documented consent for these messages, and the quiet-hours window is not a substitute for it.
