I wrote `bot.mjs` in the working directory. All behavior checks pass. I ran them from a temp directory and then deleted it. Nothing was sent.

**What it does**

- **Opt-out:** After a message that is exactly one of `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, or `QUIT`, both `freeform` and `template` are blocked with rule `opted_out`. Matching ignores case, surrounding whitespace, punctuation, symbols, zero-width characters, and full-width letters.
- **Opt-in:** `START`, `UNSTOP`, or `YES` (same normalization) clears the opt-out.
- **Ordinary sentences:** Text like "Can you stop by the store?" or "the end" is not a keyword.
- **Never wrote to us:** Both types are blocked with rule `no_prior_inbound`.
- **24-hour window:** `freeform` is blocked with `freeform_window_closed` once 24h have passed since the customer's last message. `template` is not affected.
- **Bad input fails closed:** An unknown `type` returns `invalid_type`, and an invalid `now` returns `invalid_time`. An invalid `at` in `onInbound` throws a `TypeError`.
- Allowed results return `{ allowed: true, rule: null }`.

**Choices you may want to change**

- `CANCEL` and `END` are opt-out keywords under the usual carrier convention. A bare "cancel" reply to an appointment reminder therefore stops all messages to that customer until they send `START`.
- The 24-hour window is applied to freeform on every channel, because `onInbound` does not say which channel a message came from. For SMS this is stricter than the carrier rules require.
- A customer who never wrote to us is blocked from templates too, following your rule that the assistant never contacts such customers.
- Out-of-order timestamps never shorten the window, because the latest inbound time is kept.

**Gaps**

- "Please stop texting me" does not opt the customer out. Only the exact keywords do, as you specified. If you want natural-language opt-out, that needs a separate decision, because it can also catch ordinary messages.
- Quiet hours and frequency caps are not implemented. There is no timezone data and no send log, and `check` does not record what was actually sent.
- All state is in memory, so opt-outs are lost on restart. The skill's implementation guidance says opt-outs must be honored immediately and consent records kept, so persisting this state is the next step before production use.
