`bot.mjs` is written, and the checks I ran pass. It uses only Node built-ins, so `package.json` is unchanged. Nothing is actually sent.

**What I ran:**
- **Test script:** `/tmp/t/test.mjs`, which is outside the project folder.
- **Quiet hours:** local time was correct in two US zones. I also checked the daylight-saving switch on 2 November 2026.
- **Repeats and the weekly limit:** a redelivered event, a second digest within 6 days, and a digest 7 days later behaved as intended.
- **Opt-out and START:** STOP, an opt-out from the account page, and START all took effect.
- **Eight processes racing:** I started 8 processes at once on a shared `STATE_DIR`. The same event id was sent exactly once, and one user with 8 different ids got exactly one text.
- **Restart:** a fresh process still saw an earlier opt-out.

**What `trySend` blocks**, each with a plain-sentence `reason`:
- **Repeat event:** an event id that was already sent. This covers queue redelivery and crash retries.
- **Opted out:** a user who opted out, by text or on the account page.
- **Quiet hours:** anything outside 8:00–20:00 in the user's own time zone. The federal rule allows until 21:00, but some states stop at 20:00 and a time zone doesn't tell me the state, so I used the stricter hours. A blocked event is not recorded, so a later retry can still send.
- **Too soon:** a second digest to the same user within 6 days.
- **Bad input:** an unknown time zone or a channel other than "sms".

**What `handleInbound` does:**
- **Opt-out:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT and REVOKE all opt the user out, ignoring case and punctuation. A message that starts with STOP, STOPALL, UNSUBSCRIBE, CANCEL or QUIT also counts, so "cancel my order" would opt a customer out. I chose that because wrongly texting someone who asked to stop is worse.
- **Re-subscribe:** START, UNSTOP and YES put an opted-out user back on the list.
- **HELP:** HELP and INFO get a help reply.
- **Return value:** `{ action, reply }`. Your app must send `reply` itself, and it is null when no answer is needed.
- **No reply when opted out:** an already opted-out user who texts STOP again, or any other message, gets no reply.

**Things to know:**
- **Consent:** the app gives no consent record, so I treat every user as consenting unless they opted out. If the app can enqueue a digest for someone who never agreed, that needs a separate check.
- **Opt-out wording:** `trySend` doesn't see the message text. The digest itself should say "Reply STOP to unsubscribe", at least in the first text.
- **Help contact:** the HELP reply adds a support contact only if you set the `SUPPORT_CONTACT` environment variable.
- **Corrupt state file:** `trySend` and `optOut` throw an error instead of resetting the data, so a damaged file can't silently erase opt-outs.
