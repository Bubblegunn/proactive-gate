I wrote `bot.mjs` in the working directory. It exports `onInbound` and `check`. All 19 inline checks pass. Nothing was sent.

**Rules, in the order `check` applies them:**
1. **Bad input** (`type` not `freeform`/`template`, or `now` not a valid Date) → blocked as `unknown_type` or `invalid_now`.
2. **Opt-out** → blocked as `opted_out`. Set by a whole-message STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPT-OUT or OPTOUT. Matching ignores case, outer punctuation and extra spaces. It stays until START or UNSTOP.
3. **Never written to us** → blocked as `no_inbound_history`.
4. **Freeform outside 24 h** of the customer's last message → blocked as `outside_24h_window`. Templates skip this check.

Everything else is allowed with `rule: null`.

**Choices I made that you should check:**
- **Natural-language opt-outs are not caught.** "Please stop texting me" is not an opt-out, because you said ordinary sentences containing these words are normal conversation. The cost is that a customer who asks in their own words keeps getting messages. If you want those caught, I need a rule for it, and a keyword list will not do it reliably.
- **No channel parameter.** `check` has no WhatsApp/SMS argument, so an opt-out applies to both channels and the 24 h window applies to both. SMS has no real 24 h window, so SMS freeform may be blocked more often than necessary.
- **Templates have no time limit** after a customer's last message. A customer who wrote once two years ago can still get a template. If your WhatsApp templates are marketing-category, you need a real opt-in record, which this function does not have.
- **No quiet hours or time zone.** You did not give a time zone and I did not add a block you did not ask for. Telemarketing texts in the US fall under TCPA's 8am–9pm local-time rule, so tell me if that applies.
- **In memory only**, as you asked. A restart clears all state, and a second process would have its own state. Also, `onInbound` and `check` take no message ID, so there is no protection against a redelivered webhook.
- **Invalid `at` on inbound:** the keyword is still applied (so a STOP is never lost) but the timestamp is ignored.

**Self-check results** (run inline, not saved as a test file): never-contacted users blocked for both types; freeform allowed at 1 h and blocked at 25 h; templates allowed at 72 h; STOP variants (`  stop!! `, `Unsubscribe`, `opt-out`, `OPT OUT`, `optout`, `END.`, `quit`) all block templates; `stopping`, "I will stop by the shop" and "please start" do not change the opt-out state; START restores.
