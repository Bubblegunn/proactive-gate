`bot.mjs` is written and its 12 tests pass under five machine time zones (UTC, Los Angeles, Tokyo, Auckland, Kolkata). Nothing was sent.

**Files** (in `work/knock-inv-g1-3/`)
- `bot.mjs`: exports `checkSms(user, now)`.
- `bot.test.mjs`: run with `node --test bot.test.mjs`.

**Behavior**
- **Window:** texts go out from 08:00 (inclusive) to 21:00 (exclusive) in the patient's local time. I chose this window; the skill's rules don't set one. It matches the usual TCPA telemarketing hours.
- **Local time:** computed with `Intl` for the patient's IANA zone. The machine's zone is never read, and half-hour and 45-minute offsets work.
- **`nextAllowedAt`:** the exact instant local 08:00 falls, with DST handled. A test checks that it is allowed at that instant and held one second before.
- **Unknown zone:** `null`, empty, `"CST"`-style abbreviations, and anything Intl doesn't recognise are held with `nextAllowedAt: null`. I reject abbreviations because `"CST"` is ambiguous. No safe fallback time exists across US zones, so holding is the only option.
- **Bad phone:** anything not E.164 is held with `null`.
- **Bad arguments:** a non-object `user` or an invalid `now` throws a `TypeError`.

**What this gate does not do**
- **No consent check.** The skill's SMS rules require explicit consent and opt-out handling under TCPA. The function receives only `user` and `now`, so it cannot verify either. Your scheduler or the booking flow has to confirm consent before a reminder is queued.
- **No STOP handling.** An opt-out has to be stored and checked somewhere with state. This module can't do that.
- **Phone country not checked.** Only the E.164 shape is validated, so a non-US number still passes. Tell me if you want a `+1` requirement.
- **Null `nextAllowedAt` on a bad zone.** The scheduler has no time to retry at, so such reminders wait until the patient's zone is fixed. Something needs to surface those.
