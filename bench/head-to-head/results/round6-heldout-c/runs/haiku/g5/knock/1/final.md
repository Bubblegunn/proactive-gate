`bot.mjs` is written in the working directory and all 12 tests pass (`node --test`, Node 24 locally; it only uses features available in Node 22). Nothing was sent, and I did not commit.

**Rules `check()` applies, in order:**
- `invalid-user`, `invalid-now`, `unknown-type`: fail closed.
- `opted-out`: the customer sent a STOP keyword and has not sent START since. This blocks both types.
- `freeform-no-inbound`: freeform to a customer who has never written to us.
- `freeform-window-closed`: freeform 24h or more after the customer's last message.
- Templates are allowed otherwise, including for customers who have never written.

**Keywords** match the whole message only, after lower-casing, folding full-width characters, dropping zero-width characters, and treating punctuation and extra spaces as separators. So `STOP!!`, `  stop. `, and `*Stop*` match, but "please stop by tomorrow" does not.
- STOP set: stop, stopall, stop all, unsubscribe, cancel, end, quit.
- START set: start, unstop.

**Decisions for you to check:**
- **"please stop texting me" is not an opt-out.** I read "ordinary sentences containing the word are normal conversation" literally. That means a real request phrased as a sentence will not stop messages. If you want those caught, the rule needs a separate phrase list, and that will have false positives.
- **YES does not resume messages.** It is a common opt-in word, but it is also an ordinary answer, so a stray "yes" after STOP would re-enable messaging.
- **Templates for never-written customers are allowed.** The code has no record of opt-in consent, so this assumes the platform's template rules and your onboarding cover it.
- **`onInbound` throws on bad input** (empty userId, non-string text, invalid `at`). I chose this over silently dropping a STOP.

**Not implemented:**
- **Quiet hours.** There is no customer timezone in the API, so the TCPA-style send window cannot be applied.
- **Follow-up frequency cap.** `check()` cannot see what was actually sent, so it cannot count follow-ups. Adding an outbound hook would fix this.
- **Persistence.** State is in memory only, as you specified. It is lost on restart, which would re-enable customers who opted out before the restart. The map also grows without bound.

Tests are in `/tmp/bot-test/test.mjs`, outside the repo. They cover STOP and START variants, ordinary sentences, the 24h boundary, out-of-order timestamps, and bad input.
