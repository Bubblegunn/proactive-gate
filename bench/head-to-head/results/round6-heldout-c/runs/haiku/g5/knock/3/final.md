I wrote `bot.mjs` in the work directory. All 12 behavior tests pass. Nothing was sent, and nothing is committed.

**Behavior**

- **`onInbound(userId, text, at)`** records the latest inbound time and processes the keyword. The message must be exactly one keyword after normalization (NFKC, uppercase, punctuation and spaces removed). "Stop!", "S.T.O.P.", "stop 🛑", and fullwidth "ＳＴＯＰ" all match. "please stop calling" does not.
  - Opt-out words: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT.
  - Opt-in words: START, UNSTOP.
- **`check(userId, type, now)`** returns `{ allowed, rule }` and checks in this order:
  1. `unknown-type` or `invalid-time`: fail closed.
  2. `opted-out`: blocks both types until START or UNSTOP.
  3. `no-prior-inbound`: blocks both types for a customer who never wrote to us.
  4. `freeform-window-closed`: blocks freeform text 24 hours or more after the customer's last message. Templates are not limited by this window.

**Judgment calls to review**

- **Templates to never-writers are blocked.** I read "never been contacted by the assistant" as meaning there is no opt-in on record. If your appointment reminders go to customers who never wrote in, this rule needs to change.
- **The 24-hour window applies to SMS too.** `check` gets no channel argument, so I applied the stricter WhatsApp window everywhere.
- **Bare "yes" does not re-subscribe.** I left it out of the START words because it answers unrelated questions too.
- **"START please" does not re-subscribe.** The match is the exact keyword only, to follow "the usual way that phrase is used."
- **A bare "cancel" opts the customer out.** This follows the carrier keyword list. It will silence the assistant for someone who meant "cancel my appointment."

**Not implemented**

- **Frequency cap on follow-ups.** `check` cannot count sends, because there is no record-send call and `check` runs before a send that may not happen.
- **Quiet hours.** There is no customer timezone in the input.
- **Non-English opt-out words**, such as Turkish DUR or İPTAL.

**Testing**

- The tests are in `/tmp/botcheck/bot.test.mjs`, outside the repo. Run them with `node --test`.
- I ran them on Node 24, which is what is installed here, not Node 22. The code uses only long-standing features (`Map`, `Set`, `\p{L}` regex, `normalize`).
