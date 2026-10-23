`bot.mjs` is written. It exports `reserve({ userId, timeZone, channel, now })` and enforces at most 2 marketing messages per customer per local day, across all channels combined.

**How it works**
- Each call reads `STATE_DIR` fresh, creates it if needed, and keeps one counter per user per local calendar day. The day comes from `timeZone` and the `now` you pass; it never reads the system clock.
- The counter is checked and incremented under a lock, so concurrent calls in one worker and calls from several workers can't both take the last slot. A refused call spends nothing.
- It returns `{ allowed: true, rule: "" }` or `{ allowed: false, rule: <id> }`. The `rule` values are:
  - `daily-cap`: the customer already has 2 messages that day.
  - `invalid-timezone`: the zone is missing or not a valid IANA name. The message is held, with no guess at a zone.
  - `invalid-channel`, `invalid-user`, `invalid-time`, `no-state-dir`: the input or environment is unusable. These also hold the message.
- The reserve-then-send step is two actions. If a worker reserves a slot and then crashes before sending, that slot stays used. That favors never exceeding the cap.

**What I checked**
- Six simultaneous calls for one user gave exactly 2 allowed and 4 `daily-cap`.
- Six separate processes calling at once gave 2 allowed and 4 refused.
- After a restart with the same `STATE_DIR`, the third call was still refused.
- For a Tokyo user, 23:59 local was still the same day (refused), and 00:00 local the next day was allowed again.
- A different user and zone was unaffected, and a bad zone was held.

**Not covered**
- Opt-out and consent: you didn't give me an opt-out or consent field or function, so none of that is checked. A customer who opted out of a channel would still be allowed.
- Quiet hours and message ids: I added no quiet hours. There is also no message id, so calling `reserve` twice for the same message counts twice.

The cap of 2 is the `DAILY_CAP` constant at the top of the file.
