`bot.mjs` is written and passes my checks. It needs no dependencies, so `package.json` is unchanged, and nothing was actually sent.

**What I tested**
- Eight separate processes tried to send the same digest at the same time, and exactly one got `sent: true`.
- A redelivery of that same digest was refused.
- A send at 2am Pacific was refused, and one at 9am Pacific went out.
- A bad timezone was refused.
- STOP, `" stop."`, "Unsubscribe", "please stop texting me" and "Quit" each opted the customer out, and later sends to them were refused.
- "what time?" was ignored, and HELP got the help reply.
- START re-subscribed an opted-out customer.
- I ran the whole test a second time against the same state directory. It failed, as expected, because the digest from the first run was still recorded as sent, which shows the state survives a restart.

**How it behaves**
- **Sending rules:** `trySend` checks, in order, that the channel is `sms`, that the customer hasn't opted out, that this digest id wasn't already sent, and that no digest went out in the last 6 days. It also checks that the digest was created within the last 24 hours and that the customer's local time is between 9am and 8pm. If every check passes, it records the send in the same step, so concurrent workers can't both send.
- **Inbound texts:** `handleInbound` opts the customer out on STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT or REVOKE, case-insensitive and ignoring punctuation. It also opts them out if "stop", "unsubscribe", "optout" or "revoke" appears anywhere in the text, because wrongly opting someone out is safer than texting someone who asked us to stop. START, UNSTOP and YES re-subscribe. HELP and INFO get a help reply. It returns `{ action, reply }`, and you need to send the `reply` yourself.
- **Opt-out from the account page:** `optOut` takes effect immediately.
- **State:** Each customer has one JSON file in `STATE_DIR`, protected by a lock that is cleared automatically if a worker crashes while holding it.

**Things you may want to change**
- **Consent:** The app gives me no record that a customer agreed to texts, so I can't check consent. Make sure only customers who opted in reach `trySend`.
- **Sending hours:** I used 9am to 8pm local time, which is stricter than the federal 8am to 9pm window, because some states cut off at 8pm. The values are constants at the top of the file.
- **Reply wording:** The reply texts are generic. They need your brand name and a support contact.
- **Refused sends:** Texts refused for quiet hours are not queued. The app has to call `trySend` again later, and a digest is dropped once it is more than 24 hours old.
