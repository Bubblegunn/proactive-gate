`bot.mjs` is written and its 11 tests pass (`node --test bot.test.mjs`, Node v24.13.0). Nothing is sent. The Courier skill covers the SDK and API, and this gate makes no Courier calls, so I used it only for the WhatsApp 24-hour window and the SMS keyword list.

Files are in `work/courier-inv-g5-3/`:
- `bot.mjs` exports only `onInbound(userId, text, at)` and `check(userId, type, now)`.
- `bot.test.mjs` covers the cases below.

**Rules, checked in order:**
1. `opted-out`: the customer's latest stop keyword is newer than any start keyword. Blocks both types.
2. `no-prior-inbound`: the customer has never written to us. Blocks both types.
3. `freeform-window-closed`: freeform text is blocked once 24 hours have passed since the customer's last message. Templates skip this check.

**Keyword matching:**
- Stop: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT.
- Start: START, YES, UNSTOP.
- Matching is case-insensitive and ignores punctuation, emoji, and spacing, so "S.T.O.P" and "stop!" count.
- A keyword only counts when it is the whole message. "I will stop by the store" is ordinary conversation.
- A small anchored list of polite phrases also counts as stop, such as "please stop texting me" and "don't text me anymore".

**Decisions to check:**
- **No channel parameter.** `check` has no channel argument, so the 24-hour limit applies to freeform on SMS too. That is stricter than SMS needs. If you want SMS freeform without the window, the channel has to be passed in.
- **Never-written customers are blocked, including for templates.** I read "follow up" as only applying to customers who have written to us. If the assistant ever starts first conversations, that needs its own path.
- **Phrase list is my guess.** Free-text stop requests outside those phrases, such as "leave me alone", will not opt the customer out. Treat that as a known gap.
- **Out-of-order timestamps.** A stop or start with an older timestamp does not overwrite a newer keyword. A freeform check before the last inbound is blocked.
- **Invalid input throws.** An unknown `type` or a non-Date `at`/`now` throws a `TypeError`, instead of returning a block.
- **Memory is unbounded.** The map grows with each distinct customer and is never pruned.

I have not committed anything.
