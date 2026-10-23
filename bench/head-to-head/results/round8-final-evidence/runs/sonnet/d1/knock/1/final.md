`bot.mjs` is written and passes my checks. It sends nothing and never reads the clock. I ran a test script in `/tmp/bot-test/test.mjs`, outside the repo.

The tests cover the 8:00 and 21:00 edges in Chicago, the daylight-saving change, Tokyo and Kolkata, and every rule below. They also cover 12 kinds of bad input, all of which come back as held rather than throwing.

**Rules, in the order they are checked.** A held text returns `{ allowed: false, rule }` with one of these:

| rule | applies to | holds when |
|---|---|---|
| `invalid-input` | all | `user` or `message` is missing or malformed, the kind is unknown, or the text is empty |
| `opted-out` | all | `optedOutAt` is set. A STOP reply holds transactional texts too. |
| `opt-out-unreadable` | all | `optedOutAt` is set but isn't a valid timestamp |
| `no-consent` | marketing | `optedIn` is not `true` |
| `no-opt-out-language` | marketing | the text doesn't contain the word STOP (CTIA opt-out instructions) |
| `invalid-now` | marketing | `now` isn't a valid Date |
| `timezone-missing` | marketing | the customer has no time zone |
| `timezone-invalid` | marketing | the time zone name isn't one Node recognizes |
| `quiet-hours` | marketing | the customer's local time is before 8:00 or at/after 21:00 (47 CFR 64.1200(c)(1)) |

An allowed text returns `{ allowed: true, rule: '' }`. Transactional texts skip the consent, STOP-wording, time zone and quiet-hours rules. The one rule they don't skip is a STOP reply: a customer who texted STOP gets no texts at all, including login codes.

**Choices you may want to change:**
- **Missing or bad time zone:** marketing is held rather than guessed, and no time zone is assumed.
- **STOP wording:** the check requires it in every marketing text, because I can't tell whether it was sent earlier. CTIA only asks for it in the first message and periodically, so this is stricter than required. Add a footer such as "Reply STOP to opt out" to your marketing templates.
- **8:00–21:00 window:** it is applied to India and Japan customers as well.
- **A valid but wrong time zone** can't be detected, so such a text may go out at the wrong local time.

**Not covered:**
- **Stricter state quiet hours:** some states, such as Florida and Oklahoma, end the day at 20:00. A time zone doesn't tell me the state.
- **CTIA's prohibited-content rules** (alcohol, tobacco, firearms and similar).
- **India's own texting regulations.**
