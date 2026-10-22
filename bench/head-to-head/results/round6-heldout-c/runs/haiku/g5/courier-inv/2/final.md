`bot.mjs` is written at `work/courier-inv-g5-2/bot.mjs`. All 11 test groups pass, but I ran them on Node 24.13, not Node 22. The module uses only standard features, so it should run on 22, but I haven't confirmed that. Nothing was sent, and nothing was committed. The test file is at `/tmp/bot-test/test.mjs`, outside the project.

**What Courier's docs gave me** (`channels/sms.md`, `channels/whatsapp.md`):
- Opt-out: STOP, UNSUBSCRIBE, CANCEL, END, QUIT. Opt-in: START, YES, UNSTOP.
- WhatsApp: freeform text only within 24 hours of the customer's last message. Approved templates can go out any time.

**Behaviour:**
- **Opt-out** (`opted_out`): once a customer sends a stop keyword, both `freeform` and `template` are blocked until a start keyword arrives.
- **Keyword matching**: the message is lowercased, and everything except letters is removed before comparison. So `Stop!`, `s.t.o.p`, `OPT-OUT` and `STOP 🛑` all match. A keyword only counts when it is the whole message, so `please stop texting me` and `I can't stop by` do not opt out.
- **Window** (`outside_24h_window`): freeform is allowed for 24 hours after the customer's latest inbound. Templates ignore the window.
- **Never-written customers** (`no_prior_inbound`): both types are blocked. This is my reading of "customers that have never written to us have never been contacted". Templates are blocked too, because WhatsApp requires opt-in and this module has no opt-in record for someone who never wrote. If you want template first-contact allowed, the change is one line.
- **Out-of-order events**: an inbound's `at` decides which opt change is newest. A late, older STOP does not override a newer START.
- **Invalid input**: an unknown `type` returns `invalid_type` (fails closed). A non-Date `at` or `now` throws `TypeError`.

**Decisions for you to check:**
- **YES counts as opt-in.** Courier's SMS guide lists it. The risk is that a customer who replies "yes" to an unrelated question after a STOP gets re-subscribed. If you want START and UNSTOP only, remove YES from `OPT_IN_WORDS`.
- **"stop texting me" does not opt the customer out.** That follows your rule that ordinary sentences are normal conversation, but it is a real request to stop. If you want it caught, that needs a phrase list. Be aware it will also catch some ordinary sentences.
- **State is in memory only.** A restart clears every opt-out. That is a compliance gap: a customer who sent STOP could be texted again after a deploy. Persisting the opt-out flags somewhere durable is the fix, and I would do it before going live.
