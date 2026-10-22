`bot.mjs` is written in the work directory and all 23 checks in my test script pass. Nothing was sent.

**What it does**

`check()` returns the first rule that blocks, in this order:

1. `opted_out`: the customer sent a STOP keyword and has not sent START or UNSTOP since. This blocks both freeform and template.
2. `no_prior_inbound`: the customer has never written to us. This blocks both types.
3. `freeform_window_closed`: free text is allowed only within 24 hours of the customer's last message. Templates are still allowed after that.
4. Otherwise `{ allowed: true, rule: null }`.

Keyword matching is case-insensitive and ignores surrounding punctuation, spacing, emoji and zero-width characters. Only a whole message counts. The opt-out words are STOP, STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT. The opt-in words are START and UNSTOP. "please stop texting me" is ordinary conversation, and a customer who stays opted out keeps that state through later messages.

Invalid `type` or `now` values return a blocked result instead of throwing.

**Decisions to check**

- **YES is not an opt-in word.** Carrier lists include it, but a bare "yes" in an ordinary reply would re-enable a stopped customer. Say if you want it added.
- **The 24-hour window applies to every channel.** The function takes no channel argument. WhatsApp enforces the window and SMS does not, so applying it everywhere is stricter than SMS needs. Freeform SMS to a customer older than 24 hours will be blocked. Splitting this by channel needs a channel parameter.
- **A customer who has never written gets no follow-up of any kind.** I read the spec's "never been contacted by the assistant" as a block on all follow-ups without prior inbound.
- **No frequency cap or quiet hours.** The spec didn't ask for them.
- **The Knock skill did not settle these points.** Its rule files cover copy and general compliance, with nothing on STOP keywords or the messaging window. The STOP and window rules come from the platform and carrier requirements as I understand them, so check them against your WhatsApp and carrier terms.

The tests are in `/tmp/bot-test/test.mjs` and are not in the work directory. Nothing is committed.
