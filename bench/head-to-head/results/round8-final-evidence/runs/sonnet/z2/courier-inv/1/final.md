`bot.mjs` is written and checked. It exports `trySend`, `handleInbound` and `optOut`, has no dependencies, and sends nothing.

**What `trySend` refuses** (it returns `sent: false` with a plain reason):
- **Opt-outs:** any customer who opted out, whether by texting STOP or on the account page.
- **Quiet hours:** anything outside 8am–8pm in the customer's own time zone. I used 8pm instead of the federal 9pm because some states, such as Florida, Oklahoma and Maryland, stop at 8pm. Change `WINDOW_END_HOUR` if you want the federal window.
- **Duplicates:** a digest `id` that was already sent. Queue redeliveries and a crashed worker's retry are covered.
- **Stale digests:** a digest generated more than 24 hours ago.
- **Bad input:** a missing or invalid time zone, `createdAt`, `now`, or any channel other than `sms`.
- **State errors:** any state read or write failure. It fails closed, so a corrupt state file never loses an opt-out.

Anything else returns `sent: true` and is recorded as sent in the same step.

**`handleInbound`:**
- **STOP:** It records the opt-out for STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPTOUT. It also catches phrases like "please don't text me" and "opt out". It errs toward opting out.
- **START and UNSTOP:** an exact-match message re-subscribes the customer.
- **HELP:** it returns a help reply.
- **Return value:** `{ handled, action, reply }`. Your SMS provider needs to send each `reply` text to the customer, because the bot sends nothing itself. Other texts return `{ handled: false }`.

**`optOut`** stores the opt-out per user and channel. It is safe to call more than once.

**Shared state:** each user gets one JSON file in `STATE_DIR`, with writes kept on disk across restarts. Every change happens under a per-user lock file, and a lock left by a crashed process is cleared.

**What I ran:**
- 8 worker processes sent the same digest id at once. Exactly one got `sent: true`.
- The quiet-hours edges (7:59 vs 8:00, 7:59pm vs 8pm), bad time zone and stale digest all behaved as intended.
- The STOP, START, HELP and `optOut` flow worked, and an opt-out blocked later sends.

**What this doesn't cover:**
- **Consent:** the bot has no record that a customer agreed to texts. Only send digests to customers who opted in. Keep proof of that consent.
- **Text wording:** the first digest should name your brand and say "Reply STOP to unsubscribe". The bot doesn't see the message body.
- **10DLC:** your messages must be registered under 10DLC, the US carrier registration for business texts.
- **Lost digests:** a digest marked sent is never retried, even if the worker crashes before it actually goes out. That is deliberate, so a customer never gets a digest twice.

I read the Courier SMS notes and followed their opt-out guidance, but did not use the Courier SDK.
