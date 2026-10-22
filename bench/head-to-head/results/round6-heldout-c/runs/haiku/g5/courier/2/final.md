`bot.mjs` is written at the repo root and all 45 checks pass. Nothing was sent, and I did not commit.

**What `check` allows**
- **Never-contacted customer:** `no-prior-inbound`. Both types are blocked, since we have no evidence of consent.
- **After an opt-out:** `opted-out`. Both types are blocked until a start keyword arrives.
- **Freeform:** allowed only within 24 hours of the customer's last message, else `outside-24h-window`. This is the WhatsApp service window.
- **Template:** allowed outside that window once the customer has written to us.
- **Unknown type:** `unknown-type`.

**Matching**
- Text is normalized before matching: NFKC, invisible characters removed, curly apostrophes straightened, edge punctuation and emoji stripped, case folded. "STOP!", "stop 🛑" and "S\u200Btop" all match.
- Opt-out keywords are `stop`, `stopall`, `stop all`, `unsubscribe`, `cancel`, `end`, `quit`. They match only when they are the whole message, so "please stop by the store" is ordinary conversation.
- A few whole-message sentences also count as opt-outs, such as "stop texting me" and "don't text me". Anything else, like "don't text me about the bill, call instead", passes through.
- Start keywords are `start`, `start again` and `unstop`.
- Between an opt-out and an opt-in, the later timestamp wins. On an exact tie, stop wins.

**Choices you may want to change**
- `yes` is not a start keyword. It is too common as a reply to unrelated questions.
- The 24-hour window applies to SMS too, which is stricter than SMS needs. The function has no channel parameter, so I applied the stricter rule to both channels.
- A bare `cancel` or `end` opts the customer out, because those are carrier keywords. A customer asking to cancel an appointment with that single word would stop receiving reminders.
- Nothing is sent after STOP, not even the one-time confirmation some carriers expect.
- State is in memory only, so opt-outs are lost on restart. That matches your spec, but it is a compliance risk in production.
- Bad `Date` arguments throw rather than being ignored.

**Testing**
- The checks are in `/tmp/bot-check/test.mjs`, outside the repo, and run with `node` 24.13. I did not run them on Node 22.
