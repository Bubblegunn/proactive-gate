`bot.mjs` is written at `work/baseline-g5-1/bot.mjs`. It exports `onInbound` and `check`, keeps state in memory, and sends nothing. All behavior checks pass, and `node --check` is clean. I did not commit.

**Rules, in the order `check` applies them:**

1. **`unknown_message_type`**: type is neither `"freeform"` nor `"template"`. Denied.
2. **`no_prior_inbound`**: the customer never wrote to us, or only sent a timestamp we could not parse. Denied for both types.
3. **`opted_out`**: the customer sent a stop keyword and has not sent a start keyword since. Denied for both types.
4. **Templates** are allowed after that.
5. **`invalid_now`**: `now` is not a valid Date, or is earlier than the customer's last message. Denied (fail closed).
6. **`outside_24h_window`**: freeform text only within 24 hours of the customer's last inbound message. Templates are not limited by this window.

**Keywords**
- **Opt-out (whole message only):** `stop`, `stopall`, `stop all`, `unsubscribe`, `cancel`, `end`, `quit`, `opt out`, `optout`.
- **Re-opt-in:** `start`, `unstop`.
- Matching ignores case, leading and trailing punctuation, extra spaces, invisible characters, full-width forms, and dashes or underscores between words. Spaced-out letters such as `S T O P` also match.
- Ordinary sentences such as "I can't stop thinking about my bill" or "stop texting me" are not opt-outs.

**Choices you may want to change**
- **`yes` does not re-opt-in.** CTIA lists it as a start keyword, but after a STOP it is more often an answer to something else. Adding it is one line.
- **"stop texting me" is not an opt-out.** This follows your rule that sentences containing the word are normal conversation. The cost is that a customer who writes this sentence keeps getting messages. Your call whether that is acceptable.
- **The 24-hour window applies to all channels.** `onInbound` and `check` take no channel argument, so SMS is held to the WhatsApp window as well. This is stricter than SMS needs.
- **No quiet hours and no frequency cap.** Neither was in the brief. Carriers' SMS rules often include quiet hours, but they need the customer's time zone, which the API does not carry. Tell me if you want either added.
- **Memory-only state.** A restart clears all opt-outs and inbound times. For a real opt-out list this is a compliance risk, so it should be persisted before production.

**Verification**
A test script in `/tmp/bot-check/test.mjs`, outside the repo, passes. It covers the 24-hour boundary, out-of-order timestamps, opt-out spelling variants, ordinary sentences containing keywords, re-opt-in, per-user isolation, and non-string text. The local runtime is Node 24, not 22. The code only uses features Node 22 has.
