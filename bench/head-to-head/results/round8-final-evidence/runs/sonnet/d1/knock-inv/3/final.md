`bot.mjs` is written and works. I ran 32 test cases through `checkSend` and all passed. They included odd input such as `null` user, missing arguments, a getter that throws, a bad time zone, and a string passed as `now`. Nothing was sent. The test script is `/tmp/botcheck/check.mjs`, outside your project.

The rules run in this order, and the first match holds the text. The identifiers are stable.

| rule | holds when |
|---|---|
| `invalid-input` | `user` or `message` is missing or not an object, or any unexpected error occurs |
| `invalid-kind` | `kind` is not `marketing` or `transactional` |
| `empty-text` | `text` is empty or blank |
| `opted-out` | `optedOutAt` is anything other than null or undefined. This holds transactional texts too. |
| `no-consent` | marketing only: `optedIn` is not exactly `true` |
| `no-opt-out-notice` | marketing only: the text has no "STOP" |
| `invalid-time` | marketing only: `now` is not a valid Date |
| `unknown-time-zone` | marketing only: `timeZone` is missing, not a real IANA name, or UTC/GMT/an offset |
| `outside-hours` | marketing only: the customer's local time is before 08:00 or at/after 21:00 |

**Choices I made that you may want to change:**
- **STOP blocks everything.** After a STOP, even a login code is held. I read the FCC revocation rule and CTIA as covering all texts from you. If you want transactional texts to keep going after a STOP, that is a one-line change, but check it with counsel first.
- **Transactional texts need no `optedIn`.** They go out any hour, with or without a time zone, unless the customer has opted out.
- **Marketing texts must contain "STOP".** Nothing is stored between calls, so I can't tell which text is the customer's first one. Every marketing text therefore has to carry opt-out wording, for example "Reply STOP to opt out." The check looks for the word and does not verify your wording is adequate.
- **Unknown time zone means hold.** I can't prove 8am to 9pm without it. UTC is treated as unknown because it is probably a server default. Because the zone is not verified, a valid but wrong zone, such as "America/New_York" for someone in Chicago, will pass. The function can't detect that.
- **The window ends at 9:00:00 pm.** A text sent at 8:59 pm that is delivered late could still arrive after 9. Add a margin if that worries you.
- **A garbage `optedOutAt` counts as opted out.** If a bad value gets stored in that field, those customers will be held until the data is fixed.

**What the function does not cover:**
- **India and Japan:** only the FCC and CTIA rules you named are enforced. India (TRAI DND) and Japan have their own marketing rules that I did not implement. India limits promotional texts to roughly 9am to 9pm, so the 8am start is looser than that.
- **Mixed texts:** it trusts `kind`. A "transactional" text that also sells something is legally marketing, and the function can't tell.
