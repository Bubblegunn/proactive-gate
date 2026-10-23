`bot.mjs` is written and passes my checks. It has no dependencies, so `package.json` is unchanged. Nothing was sent anywhere.

**What `trySend` blocks** (it returns `{ sent: false, reason }` for each):
- **Wrong channel:** anything that isn't `"sms"`.
- **Opted out:** customers who opted out, whether by a STOP-type reply or on the account page. This is checked again after the claims below, so an opt-out that lands mid-check still wins.
- **Quiet hours:** texts outside 9am–8pm in the customer's own time zone (from `user.timezone`, using `now`). That is stricter than the federal 8am–9pm limit, because some states (e.g. Florida) stop at 8pm. A missing or invalid time zone is also blocked.
- **Duplicate event:** the same `message.id` for the same customer is sent only once, even if the queue redelivers it or two workers race.
- **Second digest in a week:** one digest per customer per local Monday–Sunday week.

Anything not blocked returns `{ sent: true }` and is recorded as sent. If the state directory is unset or a file operation fails, `trySend` blocks the text and says so.

**Inbound replies:** `handleInbound` treats STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and "opt out" as an opt-out, even inside a sentence. That follows the FCC rule that any reasonable wording of "stop" counts. START or UNSTOP, sent as the whole message, re-subscribes, and HELP or INFO gets a help reply. It returns `{ action, reply }`, but it doesn't send the reply. Your SMS provider or the app has to send it, or the provider may already answer these keywords itself.

**Account page:** `optOut(userId, channel)` records the opt-out. A later `trySend` for that customer is then refused.

**Storage:** state is small files under `STATE_DIR`. Each decision uses an exclusive file create, so several worker processes can share it without a lock, and a crashed worker can't leave a stuck lock. State survives restarts.

**Checks:** I ran a script covering:
- 2am and 9:30pm sends (blocked).
- Duplicate event and same-week second digest (blocked).
- Next-week digest (allowed).
- STOP, START and HELP handling.
- `optOut`, and an invalid time zone.
- 8 separate processes racing on one digest (exactly one got `sent: true`).

All passed.

**Limits you should know about:**
- **No consent record:** the app gives me no record that the customer agreed to texts, so `trySend` can't check consent. It only honors opt-outs. Make sure only customers who agreed to the digest reach this gate.
- **Back-to-back weeks:** the weekly cap is per calendar week, so a Sunday send followed by a Monday send is allowed.
- **Crash window:** a worker that crashes after `trySend` says yes but before the text goes out loses that digest, because the redelivery is blocked as a duplicate.
- **Message wording:** the digest text should name the brand and say "Reply STOP to unsubscribe." That is up to whoever writes the message, since `trySend` never sees the text.
- **Carrier registration:** US business texting also needs 10DLC registration with the carriers, or delivery gets filtered.
