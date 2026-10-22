`bot.mjs` is written in the work directory. It exports `onInbound` and `check`, has no dependencies, and nothing is sent. My 34 behavior checks all pass (run from `/tmp/bot-check/check.mjs`, outside the repo). I did not commit.

**Rules, in the order `check` applies them**

1. **Bad input** (`userId`, `type` or `now` invalid): blocked with `invalid-input`. `onInbound` throws `TypeError` on bad arguments instead.
2. **Never wrote to us**: blocked for both types with `no-inbound-consent`.
3. **Opted out**: blocked for both types with `opted-out`. A customer is opted out after a STOP keyword and stays that way until a START keyword.
4. **Freeform only, clock behind the last inbound**: blocked with `now-before-last-inbound`.
5. **Freeform only, more than 24 h since the last inbound**: blocked with `outside-24h-window`. Templates skip this window because the platform allows approved templates outside it.

Anything else returns `{ allowed: true, rule: null }`.

**Choices you may want to change**

- **Keywords:** opt-out is STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT (the CTIA/Twilio list), plus a few whole-message phrases like "stop texting me" and "don't text me". Opt-in is START, UNSTOP and YES.
- **Whole message only:** "please stop" and "cancel my appointment on Friday" do not opt out. Only the bare keyword or listed phrase does.
- **Normalization:** case, surrounding punctuation, emoji, zero-width characters, full-width letters and apostrophes are ignored.
- **Out-of-order arrivals:** an older STOP or START that arrives late does not override a newer one. The timestamp decides.
- **Consent model:** any inbound message counts as consent for templates. The API has no channel or marketing-opt-in field, so I could not separate those cases.

**Gaps**

- **Quiet hours are not enforced.** The API has no customer time zone, so I could not apply a legal calling-hours window.
- **Non-English keywords are not covered.** For example, a Turkish customer's "DUR" would not opt out.
- **Bare "cancel" opts out.** A customer who means "cancel my appointment" with just that word will be opted out. This follows the carrier list, but it is the most likely false positive.
