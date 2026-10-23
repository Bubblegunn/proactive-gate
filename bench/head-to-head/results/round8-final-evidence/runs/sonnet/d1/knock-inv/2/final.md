I wrote `bot.mjs` and a test file, `bot.test.mjs`. All 14 tests pass. I ran them on Node 24.13, not 22. Nothing was sent.

**Rules, checked in this order:**

| `rule` | Applies to | Holds the text when |
|---|---|---|
| `invalid-input` | all | `user` or `message` is missing or not an object |
| `empty-message` | all | `text` is not a non-blank string |
| `opted-out` | all | `optedOutAt` is anything but null or undefined |
| `no-consent` | marketing | `optedIn` is not exactly `true` |
| `no-opt-out-info` | marketing | the text has no "reply/text/send STOP" |
| `invalid-time` | marketing | `now` is not a valid Date |
| `unknown-timezone` | marketing | `timeZone` is null, a non-IANA name, or unknown to Node |
| `quiet-hours` | marketing | local time is before 08:00 or at/after 21:00 |
| `internal-error` | all | anything unexpected throws |

- **Never throws:** `checkSend(null)` and hostile inputs return a held result.
- **Time zones:** local time comes from `Intl`, so daylight saving and India's half-hour offset are handled. The tests cover Chicago, Kolkata and Tokyo edges.
- **Unknown kind:** any `kind` other than `"transactional"` is treated as marketing, matching your definition.

**Choices I made that you may want to change:**
- **STOP blocks transactional texts too.** The FCC revocation rule (64.1200(a)(10)) and CTIA treat STOP as withdrawing consent. A stateless check can't tell which later texts the customer re-requested. This also holds a login code for someone who replied STOP. If you want order updates to continue after STOP, that is a one-line change, but check it with your counsel first.
- **A bad `optedOutAt` still counts as opted out.** An unparseable or future timestamp holds the text, so a bad value never lets a text through.
- **Unknown time zone holds marketing.** I can't infer the customer's location from anything else. "UTC", "EST" and "Etc/*" count as unknown because servers use them as defaults.
- **Transactional texts skip quiet hours and the time zone check.** The 8am–9pm rule applies to telemarketing. A transactional text still needs a non-empty body and no STOP on record.
- **Marketing must contain STOP instructions.** This is a CTIA practice, not an FCC requirement. It also means the function reads the text.
- **21:00:00 is already held.** That is stricter than the rule's literal "after 9 p.m.", and it leaves a little room for delivery delay.

**Limits:**
- The function can't tell whether a text labelled transactional actually sells something.
- India's TRAI rules (9am–9pm and DND registry) and Japan's rules are not implemented. You asked for FCC and CTIA only. India's window is stricter than the US one, so check it before texting Indian customers.
- It does not check the national Do Not Call list or re-opt-in. There is no `optedInAt` field, so any `optedOutAt` blocks sending until your system clears it.
