`bot.mjs` is written and exports `checkSend`. A 41-case check I ran against it passes. I tested on Node 24.13, not Node 22, and the code uses nothing newer than Node 22. Nothing is sent, and it reads no system clock.

**Rules, checked in this order (the first failure is returned):**

| `rule` | Applies to | Holds the text when |
|---|---|---|
| `invalid-user` | all | `user` or `user.sms` is missing or malformed, so opt-out status is unknown |
| `empty-text` | all | the text is missing or blank |
| `opted-out` | all | `optedOutAt` has any value |
| `no-consent` | marketing | `optedIn` is not exactly `true` |
| `no-opt-out-notice` | marketing | the text does not contain "STOP" |
| `invalid-time` | marketing | `now` is not a valid `Date` |
| `unknown-timezone` | marketing | `timeZone` is missing or not a real IANA zone |
| `quiet-hours` | marketing | the customer's local time is outside 08:00–21:00 |

If the whole function hits something unexpected, it returns `internal-error`. It never throws, and a failed check holds the text.

**Decisions I made that you may want to change:**
- **STOP blocks transactional texts too.** The FCC's revocation rule covers all texts from you, so a login code to someone who replied STOP is held with `opted-out`. A customer who re-subscribes will stay blocked until your code clears `optedOutAt`.
- **Anything unusual in `optedOutAt` counts as an opt-out**, including an empty string or an unparseable value. This avoids texting someone who said STOP, at the cost of sometimes holding a text that was fine.
- **Transactional texts need no opt-in and ignore quiet hours.** The customer asked for them, so a login code or shipping notice goes out at any hour, as long as there's no opt-out.
- **Mixed texts are treated as marketing.** If a "transactional" text contains sales language ("20% off", "sale", "use code", "free shipping"), it gets the marketing checks. A shipping notice with an upsell is a sales text under the FCC rules. The phrase list is a rough match, so adjust it if it catches your real order messages.
- **Unknown `kind` values are marketing**, matching your definition.
- **Marketing with no usable time zone is held**, not guessed. Your customers span US, India and Japan zones, so there is no safe fallback.
- **The window is 08:00:00 to 20:59:59 local time.** It uses the zone's rules for daylight saving. I tested the boundaries in Chicago (summer and winter), Kolkata and Tokyo.

**Not covered:**
- State rules stricter than the FCC's, such as Florida and Maryland ending at 8 pm.
- Frequency caps.
- The National Do Not Call Registry.
- Whether `optedIn: true` really reflects the written consent the FCC requires for marketing texts. The function trusts the flag.

My test script is in `/tmp/t/test.mjs`, outside the project.
