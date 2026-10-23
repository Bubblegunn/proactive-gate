`bot.mjs` is written and its 9 tests pass. Nothing was sent. The tests ran on Node v24.13.0 because that is what's installed here, so I haven't run them on Node 22. The code uses only `Intl` and `Date`, so I expect no difference. The tests are in `bot.test.mjs`.

The first test run found a bug: `checkSend(null)` threw. It now returns a held result.

**Rules, in the order they are checked.** Every held text returns `allowed: false` with one of these identifiers:
- `invalid-input`: `user`, `message` or `now` is malformed, or `now` is not a valid `Date`.
- `invalid-message-kind`: `kind` is not `"marketing"` or `"transactional"`. An unknown kind is never treated as transactional.
- `empty-text`: the text is missing or blank.
- `opted-out`: `optedOutAt` has any value other than null or undefined. An unparseable value also counts as a STOP.
- `no-consent`: `sms.optedIn` is not exactly `true`.
- `no-opt-out-text` (marketing only): the text has no "STOP" instruction. This follows CTIA.
- `unknown-time-zone` (marketing only): the profile time zone is missing, invalid, or a UTC placeholder.
- `quiet-hours` (marketing only): the customer's local time is outside 08:00 to 21:00, per 47 CFR 64.1200(c)(1). Local time comes from the profile time zone via `Intl`, so daylight saving is handled. The tests cover the 1 November 2026 change in Chicago.
- `internal-error`: any unexpected failure. The function holds the text rather than throwing.

**Choices I made that you may want to change:**
- **STOP blocks transactional texts too.** After a customer replies STOP, shipping notices and login codes are also held. The FCC's 2024 revocation rule and CTIA only allow a one-time opt-out confirmation, and this function doesn't send that. If a customer opts back in, your system needs to clear `optedOutAt`, because it overrides `optedIn`.
- **Transactional texts also need `optedIn: true`.** I took the conservative reading. If you treat giving a phone number for an order as enough consent, move the `optedIn` check below the transactional return.
- **A missing or bad time zone holds marketing.** A profile with no usable zone has no safe sending time, because no hour is inside 08:00 to 21:00 for Hawaii, India and Japan at once. Fix those profiles to unblock their marketing texts.
- **The 08:00 to 21:00 window applies to every customer**, including those in India and Japan.

**Limits:**
- A wrong but valid time zone, such as a customer who moved, can't be detected.
- A text labelled transactional that also contains a promotion is really marketing. The function can't detect that, so the label has to be right.
- Several states have quiet hours stricter than the FCC's. Florida and Oklahoma end at 8 p.m., and Texas starts at 9 a.m. I kept to the FCC window as you asked. Check with counsel if you have customers in those states.
