`bot.mjs` is written and exports `checkSend`. I tested it with 20 cases plus several malformed inputs, and nothing sent. A first run threw on a `null` argument, so I fixed that. The final run passed everything and returned a hold, never a throw. The test script is in `/tmp/t1`, not in your repo.

Checks run in this order, and the first one that fails sets `rule`:

| `rule` | Held when |
|---|---|
| `invalid-input` | `user` or `message` is missing or not an object |
| `invalid-kind` | `kind` is neither "marketing" nor "transactional" |
| `empty-text` | `text` is not a string or is blank |
| `opted-out` | `optedOutAt` has any value. This holds transactional texts too, because STOP should stop the program. It also holds if the timestamp is unparseable or in the future. |
| `no-consent` | Marketing only, and `optedIn` is not exactly `true` or `sms` is missing |
| `invalid-time` | Marketing only, and `now` is not a valid Date |
| `unknown-timezone` | Marketing only, and `timeZone` is missing, blank or not a real IANA name |
| `quiet-hours` | Marketing only, and the customer's local time is before 8:00 or at 21:00 or later (47 CFR 64.1200(c)(1)) |
| `no-opt-out-text` | Marketing only, and the text does not contain the word STOP |

When `allowed` is true, `rule` is `""`.

- **Quiet hours:** they are computed from `now` in the customer's own time zone, so a server in UTC doesn't matter. I tested Chicago, Tokyo and Kolkata.
- **Bad profile time zones:** a missing or invalid `timeZone` holds marketing. I did not guess a zone, because a wrong guess could text someone at 3am. Transactional texts are not affected by time of day.
- **Transactional without opt-in:** these go out if there is no opt-out. A login code the customer requested doesn't need marketing consent.
- **STOP-text rule:** this is my addition, based on the CTIA guidance that sales texts include opt-out instructions. Delete the last check if you add the STOP line some other way.

What the function cannot do:
- It can't check the National Do Not Call Registry or your own do-not-call list.
- It can't check that `optedIn` came from written, express consent.
- It can't tell whether a text marked transactional really is one.
- It doesn't apply India's DND rules or Japan's consent law. I only applied the US 8am–9pm window to every customer, which is also safe in India and Japan.
