`bot.mjs` is written in the work directory, and all 25 test groups pass. The tests ran from `/tmp`, so the repo has only `bot.mjs`. Nothing was sent.

**Rules, checked in this order:**
1. **`opted-out`**: the whole message, after trimming punctuation, emoji and spaces and ignoring case, is `stop`, `stopall`, `unsubscribe`, `cancel`, `end` or `quit`. This blocks both freeform and template until the customer sends `start`, `unstop` or `yes`.
2. **`no-prior-inbound`**: a customer who has never written to us gets no message of either type.
3. **`outside-24h-window`**: freeform is allowed only less than 24 hours after the customer's last message. Templates skip this check.

Any other input (bad type, bad date, empty id) returns `invalid-input` and fails closed.

**Choices I made that you should check:**
- **Keyword matching is whole-message only.** "please stop texting me" is ordinary conversation and does not opt out. The cost is that a message like that, which clearly asks us to stop, does not block. Say if you want phrase matching instead.
- **`cancel` and `yes` are treated as keywords.** These follow the carrier lists. "Cancel" can mean "cancel my appointment," so it is a conservative choice that may cause an over-opt-out.
- **The 24-hour window applies to both channels.** `check` does not take a channel argument. WhatsApp requires the window, and SMS has no window, so this is stricter than SMS needs. Add a channel argument if you want per-channel rules.
- **Opt-out blocks templates too.** A reminder template to an opted-out customer is blocked.
- **The window is strictly under 24 hours.** At exactly 24 hours, freeform is blocked.

**Not implemented:** quiet hours and frequency caps. The spec gives no timezone or cap values, and the skill's rules call for both. Say what you want and I will add them.
