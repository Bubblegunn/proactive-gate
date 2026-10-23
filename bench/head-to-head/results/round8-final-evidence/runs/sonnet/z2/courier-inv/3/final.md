`bot.mjs` is written and exports `trySend`, `handleInbound` and `optOut`. It uses no dependencies, so `package.json` is unchanged. I also added `test.mjs`, a script that checks the behavior. It passes with `node test.mjs` ("all ok"), and nothing is sent.

The system noted that `bot.mjs` changed on disk after I wrote it. I didn't read the file again, so the test ran against whatever was on disk at that point.

**What `trySend` checks before it returns `sent: true`:**
- **Opt-out:** blocked if the customer texted STOP or used the account page, per channel.
- **Duplicates:** a digest `message.id` that was already approved is never approved again, so redelivery and worker crashes are safe. The id is recorded as sent at the moment `trySend` returns true.
- **Quiet hours:** only 8:00 to 20:59 in the customer's own time zone, which is the US legal window. A missing or invalid timezone is refused. A quiet-hours refusal records nothing, so a later retry still works.
- **Frequency:** at most one digest per customer per 6 days. I chose this limit myself because you said "weekly"; change `MIN_GAP_MS` in `bot.mjs` if you want something else.
- **Channel:** only `"sms"` is accepted.

**What `handleInbound` does:**
- **Opt-out:** exact keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) count as opt-outs, ignoring case and punctuation. So do clear phrases such as "please stop texting me". Ordinary sentences containing "end" do not.
- **Resubscribe and help:** START or UNSTOP resubscribes. HELP returns help text.
- **Return value:** each call returns `{ action, reply }`. Sending the reply is up to you. Carriers expect confirmations for STOP, START and HELP.
- **Reply wording:** the replies don't name your brand. Add the name before using them.

**Shared state:**
- **Storage:** there is one JSON file per user in `STATE_DIR`, which is created if missing. Writes are atomic and flushed to disk.
- **Locking:** a per-user lock directory covers the workers on one machine. A lock left behind by a crashed worker is cleared after 15 seconds.
- **Verified:** 12 separate processes sent the same digest id at once and exactly one was approved. A fresh process still saw that id as sent.

**Open points:**
- **Consent:** the app gives me no record of whether a customer ever agreed to texts, so I treat everyone as subscribed unless they opted out. If you don't already hold consent before calling `trySend`, add that check. A weekly digest may also count as marketing, which needs written consent.
- **Message text:** `trySend` doesn't see the message body. The digest text itself should include your brand name and "Reply STOP to unsubscribe".
- **Phone provider:** Twilio blocks sends to numbers that replied STOP, so the provider's own opt-out list is a second layer. This code is the first.
- **Carrier registration:** US business texting also needs 10DLC registration with the carriers. That is a setup step outside this code.
