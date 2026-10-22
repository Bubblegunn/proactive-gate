Wrote `bot.mjs` in the work directory. All 16 test groups pass, and nothing is sent.

**Rule:** a text may go out only when the patient's local time is 08:00 to 20:00, using the IANA zone they picked. Both hours are constants at the top of the file, so you can change them.

**Results:**
- **Allowed:** `{ allowed: true, reason, nextAllowedAt: null }` inside the window.
- **Held before 08:00 or from 20:00 on:** `nextAllowedAt` is the exact instant the window opens, with a reason that names the local time and the reopen time.
- **Timezone null, unknown, or not a string:** held, `nextAllowedAt: null`, because waiting cannot fix it.
- **Phone not in `+country` format:** held, `nextAllowedAt: null`. This check is my addition. Say if you don't want it.
- **`now` not a valid Date:** throws a `TypeError`.

**Tests** (run from `/tmp/bot-test/test.mjs`):
- Exact boundaries: `nextAllowedAt` is allowed, and 1 ms earlier is held.
- Half-hour zones: Kolkata and Adelaide.
- DST days in Chicago, both spring and fall.
- Month and day rollovers in Honolulu and New York.
- Bad and missing timezones.
- Same result under four machine `TZ` settings.

This sandbox has Node v24 only. I used features that exist in Node 22, but I did not run the file on Node 22.

**Not covered, because the input has no data for it:**
- **Opt-outs:** the function cannot see STOP or opt-out status. The scheduler must check that before calling it.
- **Frequency caps:** the function is stateless, so it cannot limit how many texts a patient gets per day.
- **Same-day appointments:** a reminder held until the next morning may arrive after the appointment time. The scheduler should handle that case.
