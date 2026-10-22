I wrote `bot.mjs` with `checkSms(user, now)` and a test file, `bot.test.mjs`. All 12 tests pass on Node 24 under machine time zones UTC, Asia/Tokyo and America/Los_Angeles. Nothing was sent. I did not run it on Node 22, but it only uses `Intl` and `Date`, which Node 22 supports.

**Rule:** a text may go out only between 08:00 and 21:00 on the patient's local clock. The window is start-inclusive and end-exclusive, so 08:00:00.000 is allowed and 21:00:00.000 is held. Local time is computed from the IANA zone, so half-hour zones (India, Adelaide) and DST changes are handled. The machine's time zone is never read.

**Results:**
- Allowed: `{ allowed: true, reason, nextAllowedAt: null }`.
- Held before 08:00 local: `nextAllowedAt` is 08:00 today in the patient's zone.
- Held from 21:00 local: `nextAllowedAt` is 08:00 tomorrow.
- Null, empty, or unrecognised time zone: held, `nextAllowedAt: null`. The scheduler has no time to retry at, so it needs to handle null by waiting for a fix to the record.
- Phone not in E.164 form (for example `3125550142` or `+0123`): held, `nextAllowedAt: null`. I added this check; it was not in your spec.
- Invalid `now` or non-object `user`: throws `TypeError`. These are programming errors, so they should fail loudly.

**Choices you should confirm:**
- **Non-US numbers use the same 08:00–21:00 window.** I did not verify the texting rules of the other countries. If any of them are stricter, the window needs a per-country table.
- **No weekend or holiday rules.** Your spec did not mention them.
- **No consent check and no frequency cap.** The function sees only `user` and `now`, with no state and no consent field. The "patients did not ask for these one by one" concern therefore has to be handled by the caller, for example by checking opt-in and per-patient send limits before calling `checkSms`.

Files are in `work/baseline-g1-2/`: `bot.mjs` and `bot.test.mjs`. Run the tests with `node --test bot.test.mjs`.
