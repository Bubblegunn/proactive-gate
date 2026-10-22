`bot.mjs` is written at `work/courier-inv-g5-1/bot.mjs`. All checks in my local test pass. Nothing was sent. The Courier skill covers the Courier API, and this module makes no Courier calls, so I wrote it without the skill's SDK patterns.

**Rules, in the order `check` applies them:**

1. **`invalid-type`**: `type` is not `"freeform"` or `"template"`.
2. **`no-prior-inbound`**: the customer has never written to us.
3. **`opted-out`**: the customer's last opt-out keyword was STOP. This blocks both types until START.
4. **`window-closed`**: freeform text more than 24 hours after the customer's last message. Templates are still allowed.

Otherwise `check` returns `{ allowed: true, rule: null }`.

**Keywords:** A message counts only if, after removing everything except letters and digits and lowercasing, it equals a keyword. This covers `STOP`, `stop!`, ` Stop. `, `s-t-o-p`, and full-width `ＳＴＯＰ`. Opt-out words are STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT. Opt-in words are START and UNSTOP. "Stop by the store tomorrow" is treated as normal conversation.

**Decisions to confirm:**
- **No channel parameter.** `check` has no channel argument, so the 24-hour window applies to all freeform text, including SMS. That is stricter than SMS needs, but it is safe. If SMS should be unrestricted, add a channel argument.
- **The window closes at exactly 24 hours**, not after it.
- **`CANCEL` and `END` are opt-out words.** The standard lists include them, but a customer who types "cancel" about an appointment will stop all follow-ups. Remove them if that is a problem.
- **`YES` is not an opt-in word.** Some platform defaults include it. I left it out because a stray "yes" would re-enable messaging.
- **Whole-message matching has a gap.** "Please stop texting me" is not treated as an opt-out, per your rule about ordinary sentences. The cost is that a real opt-out phrased that way is ignored. You may want to add polite variants such as "stop please".
- **Out-of-order arrivals:** the latest message time sets the window, but opt-out state follows arrival order.

**Testing:** I ran a test script in `/tmp/bot-test-courier/test.mjs` covering every rule above. It passed on Node v24.13.0, the only version installed here. The code uses only standard features, but I did not test it on Node 22 itself.
