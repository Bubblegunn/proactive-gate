I wrote `bot.mjs` in the work directory. It exports only `onInbound` and `check`, both synchronous, with state held in memory. All 36 behavioral checks pass. The checks ran from a scratch directory in `/tmp`, so the repo has only `bot.mjs`. I did not commit it.

**Rules, in the order `check` applies them:**
1. **`unknown-type`**: `type` must be `"freeform"` or `"template"`.
2. **`opted-out`**: blocks both types if the customer's latest stop-type message is newer than their latest start-type message. Ordering uses the `at` timestamp, so a late-arriving old STOP does not override a newer START.
3. **`no-open-window`** / **`window-closed`**: freeform needs a customer message within the last 24 hours. Templates skip this check.

**Matching:** Text is normalized by NFKC, invisible characters are removed, case is folded, and punctuation and emoji are stripped. Keywords match the whole message only, so "stop by the shop" and "can you start my service again?" are normal conversation.
- Stop words: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT (the standard carrier list).
- Restart words: START, UNSTOP.
- Plain-language phrases: "please stop", "stop texting me", "stop messaging me please", and similar short variants. I added these so that "please stop texting me" is treated as an opt-out.

**Decisions to confirm:**
- **Templates to never-written customers are allowed** unless they have opted out. The brief says these customers have never been contacted, so I read it as "no prior contact, no opt-out." WhatsApp also requires opt-in for business-initiated messages, and the bot cannot see that opt-in. If you need to block templates for customers who have never written, that is a one-line change.
- **YES is not a restart word.** It is common in ordinary replies, so I left it out.

**Limits:**
- `check` does not record outbound sends. Any follow-up frequency cap would need its own state.
- Templates are not checked against the registered template list.
- Opt-out phrasings beyond the list above are not caught. Route those to a human.

The sandbox runs Node 24; the code uses only features available in Node 22.
