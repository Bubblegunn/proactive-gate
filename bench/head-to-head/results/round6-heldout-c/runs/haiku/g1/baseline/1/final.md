Wrote `bot.mjs` and `bot.test.mjs` in the working directory. All 13 tests pass (`node --test bot.test.mjs`). Nothing was sent and nothing was committed.

**What `checkSms(user, now)` does**
- **Send window:** texts go out only between 09:00 and 20:00 on the patient's local clock. The window starts at 09:00 inclusive and ends at 20:00 exclusive. I chose this narrower than the 08:00–21:00 legal limit because of the complaint you already had. It is one constant at the top of the file if you want a different window.
- **Local time:** computed with `Intl` for the patient's zone, so DST and half-hour or 45-minute offsets are handled. The machine's time zone is never used.
- **Held messages:** when it returns `allowed: false`, `nextAllowedAt` is the exact instant of the next 09:00 local. A test confirms the text is allowed at that instant and held one millisecond before.
- **Unknown zone:** if `timezone` is null, empty, unrecognised, or not an IANA name, the text is held with `nextAllowedAt: null`, because no retry time can be predicted.
- **Bad phone:** a number that is not E.164 (`+` then digits) is held with `nextAllowedAt: null`, since retrying will not fix it.
- **Bad `now`:** an invalid Date throws a `TypeError`.

**Limits to know about**
- The function gets no consent data, so it cannot check whether a patient opted in. It only enforces when texts may go out. If the complaint was about unrequested texts and not only timing, the scheduler must check opt-in separately, or you need to pass an opt-in field into this function.
- There is no weekend or holiday rule and no per-patient daily cap. Both would need state or more input.
- I ran the tests on the local Node 24.13. I used only features that exist in Node 22, but I did not run them on Node 22 itself.
