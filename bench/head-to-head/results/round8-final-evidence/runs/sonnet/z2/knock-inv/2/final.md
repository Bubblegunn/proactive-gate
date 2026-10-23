`bot.mjs` is written and tested. It uses no dependencies, so I didn't touch `package.json`. I ran my own tests, including 12 worker processes racing on the same digest. Exactly one got "sent" and the other 11 were refused. Nothing was actually sent.

The gate runs these checks in order, and any failure returns `{ sent: false, reason }`:
- **Opt-out:** a customer who opted out is never texted. This check comes first.
- **Redelivery:** a digest id that was already sent is refused, so a crashed and redelivered job can't double-send.
- **Quiet hours:** texts go out only between 8am and 8pm in the customer's own time zone. The legal limit is 8am to 9pm, and I stopped an hour early because some states are stricter. An unknown time zone is refused.
- **Weekly limit:** one digest per customer per 6 days. The 6 days (instead of 7) leaves room for sends that were pushed back by quiet hours.
- **Channel:** anything other than `"sms"` is refused.

On a pass, the send is recorded and `{ sent: true }` comes back.

**Inbound texts and opt-outs**
- **Stop words:** `handleInbound` treats STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPTOUT as an opt-out. Case and punctuation don't matter, and the word must be the whole message. "please stop texting" does not count.
- **START and HELP:** START, UNSTOP or YES resubscribes the customer, and HELP gets a help reply.
- **Replies:** the return value is `{ handled, action, reply }`. You need to send the `reply` yourself, because the bot sends nothing.
- **Account page:** `optOut` records an opt-out the same way, and it takes effect right away for every worker.

Per-customer state lives in files under `STATE_DIR`, so it survives a restart. A lock file keeps the workers from overwriting each other. Each file also keeps a short log of sends and opt-ins/opt-outs.

Two limits in the data the app gives me:
- **Consent:** there is no consent record, so the gate can't check that a customer opted in. Only send to customers who agreed to digest texts. The gate adds only the opt-out check.
- **Message text:** `message` has no text body. The first digest text must include the sender name and "Reply STOP to unsubscribe". Whatever builds the text has to add them.
