I wrote `bot.mjs` in the work directory. It exports `onInbound` and `check`, keeps all state in memory, and sends nothing. A 56-check script that lives outside the work tree passes against it. I ran it on Node 24 (the sandbox's version); the code only uses features that exist in Node 22.

**How it decides**

- **Opt-out:** after normalizing the message (Unicode NFKC, invisible characters removed, whitespace collapsed, leading and trailing punctuation or symbols stripped, lowercased), the whole message must equal `stop`, `stopall`, `unsubscribe`, `cancel`, `end` or `quit`. Once opted out, both `freeform` and `template` are blocked with rule `opted-out`.
- **Opt-in:** `start` or `unstop` clears the opt-out.
- **Freeform window:** a `freeform` message is allowed only if the customer's latest message is less than 24 hours old. Anyone who never wrote gets rule `freeform-outside-24h-window`.
- **Templates:** allowed for anyone who is not opted out, including customers who never wrote to us.
- **Bad input:** a non-Date `at` or `now`, or an unknown `type`, throws a `TypeError`.

**Choices you should check**

- **Free-text opt-outs are not caught.** "Please stop texting me" is treated as ordinary conversation, because only whole-message keywords count. If customers often write that, the assistant must handle it, or we add a rule for it. Right now it is a compliance gap.
- **YES is not an opt-in word.** It is ambiguous outside a consent prompt. Add it if your opt-in flow needs it.
- **Templates to never-written customers are allowed.** The code has no opt-in record, so it assumes the platform's opt-in happens upstream, for example at booking. If that is not true, template sends to these customers must be blocked.
- **The 24-hour window applies to SMS too.** `check` gets no channel argument, so this is the conservative choice.
- **No follow-up frequency cap.** Nothing records sends, so I did not add a cap. The spec did not ask for one.
- **Restart loses opt-outs.** Memory-only state means a customer who texted STOP before a restart can be messaged again. This is a real compliance risk. You may want to persist the opted-out set.
- **Keyword order follows arrival order.** A late-arriving STOP overrides an earlier START. The 24-hour window uses the newest `at`, so out-of-order timestamps cannot shorten it.
