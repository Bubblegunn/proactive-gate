I wrote `bot.mjs` in the work directory. It exports `onInbound` and `check`, keeps state in memory, and sends nothing. Its 13 behavioural test groups pass, and `node --check` is clean. The tests live in `/tmp/bot-check/check.mjs`, outside the repo, so I didn't add a test file. I didn't commit.

**Rules, checked in this order:**
1. `type` is not `"freeform"` or `"template"`: blocked as `unknown-type`. `now` is not a valid Date: `invalid-now`.
2. The customer has never written to us: blocked as `no-prior-inbound`, for both types.
3. The latest opt-out/opt-in event is a stop: blocked as `opted-out`, for both types.
4. Freeform and 24 hours or more since the customer's last message: blocked as `freeform-window-closed`. Templates are allowed outside the window.
5. Otherwise `{ allowed: true, rule: null }`.

**Message matching:** the text is NFKC-normalized, invisible characters are dropped, and leading/trailing punctuation, spaces and emoji are stripped before an uppercase whole-message match. So `stop!`, ` Stop. ` and `ＳＴＯＰ` all count, and `please don't stop` does not.
- Opt-out words: STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT.
- Restart words: START, UNSTOP.

**Choices you may want to change:**
- **Opt-out is whole-message only.** A message like "stop texting me" will not opt the customer out. That follows your "ordinary sentences are normal conversation" rule, but it means a clear request in plain words is not honored. You may want a deliberate free-text opt-out rule.
- **YES is not a restart word.** I left it out because a plain "yes" after a STOP is ambiguous. CTIA lists it, so add it if you want that.
- **The 24-hour window applies to all freeform, including SMS.** `onInbound` gets no channel, so I can't tell SMS from WhatsApp. Applying the WhatsApp window everywhere is the conservative choice.
- **Out-of-order timestamps are handled.** The latest opt-out/opt-in by timestamp wins, and the window uses the latest inbound time.
- **Invalid input is handled differently.** `check` fails closed and returns a block with a rule name. `onInbound` throws a TypeError on an invalid `at`, so a bad timestamp is not recorded silently.

**Not implemented:** quiet hours, a frequency cap, and per-channel rules. Those are carrier and TCPA concerns that the spec did not mention, and an SMS deployment will probably need them.
