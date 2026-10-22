`bot.mjs` is written at `work/ours-g5-1/bot.mjs`. It exports `onInbound` and `check`, keeps state in memory only, and sends nothing. The inline self-check passed all 31 cases. The only Node here is v24.13.0; I did not run it on Node 22, but the code uses nothing newer than Node 22 supports.

**Rules (the first `rule` value is the identifier returned):**
- `opted-out`: blocks both types. Set by STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPT-OUT, OPTOUT. Matching ignores case, outer punctuation and symbols, and extra spaces. Ordinary sentences containing these words are not matched.
- `opted-out` is cleared by START or UNSTOP sent after the latest STOP. An older START never undoes a newer STOP.
- `outside-24h-window`: freeform is allowed only within 24 hours after the customer's last message. This is the WhatsApp service window.
- `no-customer-contact`: templates are blocked for users who have never written to us.
- `invalid-type`, `invalid-time`, `invalid-user`: bad input to `check` is blocked.

**Choices to confirm:**
- **Never-contacted customers get no templates.** I read "no inbound message on record" as no consent. If your appointment reminders go to customers who have never written, this block is wrong, and you should remove the `no-customer-contact` line in `check`.
- **Freeform uses the WhatsApp 24-hour window for SMS too.** `check` does not receive a channel, so I could not split the two.
- **One opt-out covers all channels.** A STOP on either channel blocks both.
- **YES is not a restart keyword.** A customer who texts YES after opting out stays opted out. That is the safe side of the ambiguity.
- **Not added (no rule in the brief):** quiet hours, time zones, and frequency caps. A follow-up at 3 a.m. is allowed. If the TCPA 8 a.m.–9 p.m. window applies to these messages, it needs a time zone per user, which the API does not provide.
- **Input errors:** `onInbound` throws on an invalid `userId` or `at`. A non-string `text` (such as a media message) counts as contact with no keyword.

Nothing is committed.
