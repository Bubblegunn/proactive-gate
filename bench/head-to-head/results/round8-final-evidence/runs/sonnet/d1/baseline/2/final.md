`bot.mjs` is written and passes my 31 checks. Those cover quiet-hour boundaries in summer and winter, India, Japan, bad or missing time zones, opt-out, and odd input such as `null` arguments and a getter that throws. Nothing was sent, and the test script is in `/tmp`, not in your repo.

Checks run in this order, and the first one that matches holds the text:

| `rule` | When it holds the text |
|---|---|
| `invalid-input` | Anything malformed: `now` not a valid Date, unknown `kind`, empty text, missing `sms`, or an unexpected exception. It fails closed and never throws. |
| `opted-out` | `optedOutAt` is anything other than `null` or `undefined`, for any kind of text. An unparseable value still counts as opted out. |
| `no-consent` | Marketing text and `optedIn` is not exactly `true`. |
| `no-valid-time-zone` | Marketing text and the customer's local time can't be worked out. |
| `quiet-hours` | Marketing text outside 8:00 a.m. to 9:00 p.m. in the customer's own time zone, per 47 CFR 64.1200(c)(1). 9:00:00 p.m. exactly is held. |
| `no-opt-out-notice` | Marketing text with no "STOP" in it. CTIA expects opt-out instructions, and since nothing is stored between calls, every marketing text needs one. |

When the text is allowed, `rule` is the empty string.

Some of these are my judgment calls, so check them:
- **Transactional texts** skip consent, quiet hours and the STOP footer. They are held only if the customer has opted out. A login code goes out even if `optedIn` is false, because the customer gave their number and asked for it. If you'd rather hold those, add a check on `optedIn`.
- **Promotional wording in a transactional text:** a text marked transactional that contains things like "20% off", "use code" or "shop now" is treated as marketing. A shipping notice with a coupon attached counts as a sale text under the FCC rules.
- **Time zone values:** `UTC`, `GMT`, `Etc/*` and bare abbreviations like `EST` are treated as wrong. They are usually a server default, and `EST` ignores daylight saving. A missing or wrong zone holds marketing, because there is no safe hour to guess.
- **Opt-out covers everything:** after a STOP reply, even a login code is held. Use another channel for those customers, such as email.

The function does not check:
- **Sender name:** CTIA wants your business name in the first text, and the function doesn't check for it.
- **Do-not-call lists:** the National Do Not Call Registry is not checked, because there is no input for it.
- **State rules:** some states set stricter hours (for example Florida, 8 p.m. cutoff). India (TRAI) also has its own promotional hours, 9 a.m. to 9 p.m. Only the FCC window is applied.
- **Restricted content:** CTIA's prohibited-content categories (alcohol, tobacco, firearms and similar) are not checked.
