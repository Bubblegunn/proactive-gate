`bot.mjs` is written and its 15 tests pass under five machine time zones (UTC, Los Angeles, Kiritimati, Kathmandu, New York). Nothing is sent and the module makes no network calls. I ran it on Node 24 only; it uses only Node 22-era APIs, but I did not run it on Node 22.

**Rule:** a text may go out only when the patient's local time is 08:00 to 21:00 (08:00 inclusive, 21:00 exclusive). Each check uses that zone's real local clock through `Intl`, so half-hour and 45-minute zones and DST changes are handled.

**Returns:**
- **Allowed:** `{ allowed: true, reason, nextAllowedAt: null }`.
- **Held, valid zone:** the reason names the local time, e.g. "it is 07:59 in America/Chicago". `nextAllowedAt` is the first whole minute when the window is open, so the scheduler never retries early. Tests check that the instant one millisecond earlier is still held.
- **Held, no usable zone:** `timezone` is null, empty, or unrecognised, so the function falls back to the window that is open in every US zone (Eastern through Hawaii/Aleutian), which is 18:00 to about 01:00 UTC. For a US number (`+1` plus 10 digits) it returns the next time that window opens.
- **Held, no usable zone and not a US number:** returns `nextAllowedAt: null`, because the local hours cannot be known. Your scheduler should treat `null` as "do not auto-retry; fix the patient's zone."
- An invalid `now` throws a `TypeError`.

**Limits you should decide on:**
- **Consent is not checked.** The input has no consent field, and the function only checks timing. The complaint you mentioned suggests this is the bigger risk. If patients have not opted in, this gate will not stop those texts.
- **No frequency cap.** Without state, the function cannot limit how many texts one patient gets.
- **US fallback excludes territories** (Puerto Rico, Guam, Samoa). Adding them would narrow the common window, possibly to nothing.
- **Courier alternative.** The Courier docs recommend a native delivery window (`delay.until` with a timezone) for quiet hours, not app-side logic. If you send through Courier, that is the simpler route. This gate is still useful if the SMS vendor is called directly.

Files are in `work/courier-inv-g1-3/`: `bot.mjs` and `bot.test.mjs`. Run the tests with `node --test bot.test.mjs`. I did not commit anything.
