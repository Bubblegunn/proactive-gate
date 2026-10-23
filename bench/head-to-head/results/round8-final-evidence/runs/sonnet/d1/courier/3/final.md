`bot.mjs` is written and exports `checkSend({ user, message, now })`. I checked it with a 33-case script in `/tmp/bot-check/check.mjs` (outside your repo), and all cases pass. It sends nothing and never reads the clock.

**What it holds, in the order it checks:**

| rule | when |
|---|---|
| `invalid-input` | The argument, `user` or `message` is not an object. |
| `invalid-kind` | `kind` is not exactly "marketing" or "transactional". |
| `empty-message` | `text` is not a non-blank string. |
| `opted-out` | `optedOutAt` is set to anything at all, including garbage. This holds both kinds. |
| `no-consent` | Marketing text, and `optedIn` is not exactly `true`. |
| `no-opt-out-notice` | Marketing text that does not contain the word STOP. |
| `invalid-time` | Marketing text, and `now` is not a valid Date. |
| `unknown-time-zone` | Marketing text, and `timeZone` is missing, not a real IANA name, a fixed offset like "+05:00", or a UTC/GMT/Etc placeholder. |
| `quiet-hours` | Marketing text, and the customer's local time is outside 08:00–21:00. |
| `internal-error` | Anything unexpected. It holds the text instead of throwing. |

A transactional text is allowed regardless of consent flag, time of day, time zone or `now`. The only things that stop it are `opted-out` and malformed input.

**Choices you may want to change:**
- **STOP blocks order updates too.** I held transactional texts after a STOP reply, to be safe. If you want shipping notices or login codes to keep flowing after STOP, change the `opted-out` check.
- **No usable time zone means hold.** I could not safely guess a send window for customers across the US, India and Japan, so a marketing text with a missing or bad time zone is held. A time zone of "UTC" counts as unusable, because that is the server default and not where the customer lives.
- **The STOP-wording requirement is my reading of CTIA.** I could not confirm it demands this in every marketing text. It is easy to remove if you handle opt-out wording elsewhere.
- **The cutoff is exact.** A text at 20:59:59 passes, and one that arrives after 21:00 because of carrier delay would not be caught. Add a small buffer if that worries you.

**Not covered:**
- Some states have stricter hours than the FCC's 8 a.m.–9 p.m., for example Florida's 8 p.m. cutoff.
- India and Japan have their own consent and do-not-disturb rules, which this does not check.
- A text mixing an order update with a sales pitch is treated as whatever `kind` says. The FCC may treat it as marketing.

The checker also caught one bug in my first version. `checkSend(null)` threw before the error handling started, and I fixed it.
