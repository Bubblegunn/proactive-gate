`bot.mjs` is written at `work/baseline-g5-2/bot.mjs`. It exports `onInbound` and `check`, keeps state in memory, and sends nothing. My 12 behavior tests all pass. They live in `/tmp/bot-check/`, outside the work directory. I ran them on Node 24 (the machine's version), and the code uses only features that Node 22 supports.

**Rules, in the order `check` applies them:**
- **`opted_out`**: blocks both freeform and template after an opt-out keyword, until a start keyword.
- **`unknown_type`**: blocks any type other than `"freeform"` or `"template"`.
- **`no_open_service_window`**: blocks freeform unless the customer wrote less than 24 hours before `now`. The window is exclusive at exactly 24 hours.
- Templates pass otherwise, with no time limit.

**Decisions you should check:**
- **Never-contacted customers:** templates are allowed as a first contact, and freeform is blocked because there is no open window. If your WhatsApp setup requires an explicit opt-in before any template, this needs a change.
- **Opt-out keywords:** `stop`, `stopall`, `unsubscribe`, `cancel`, `end`, `quit` (the CTIA set). A message counts only if the whole message is one of these after trimming, case-folding, and removing outer punctuation and emoji. "stop by the store" is not an opt-out.
- **Gap:** phrases such as "please stop texting me" are not detected. Catching them would mean classifying free text, which the spec rules out for ordinary sentences. Those customers stay opted in until they send a bare keyword. Tell me if you want a phrase list added.
- **Opt-in keywords:** `start` and `unstop` only. I left out `yes`, which CTIA also lists. A customer who replies "yes" to something unrelated would otherwise be re-subscribed without intent. Adding it is a one-word change.
- **No frequency cap:** the API has no way to record that a message was actually sent, so I did not build a limit on follow-up counts.

I did not commit anything.
