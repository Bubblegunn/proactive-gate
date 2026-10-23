`bot.mjs` is written and tested. It has no dependencies and `package.json` is unchanged. Nothing was actually sent.

**`trySend`** returns `sent: false` with a plain reason in these cases:
- **Already sent:** the digest `message.id` was already sent. A redelivery or a crashed worker's retry never texts twice. Each id is claimed with an atomic exclusive file create in `STATE_DIR`, so only one worker can win. The claim survives restarts.
- **Opted out:** the customer opted out. The check runs again after the claim, so an opt-out that lands mid-check still wins and the claim is released.
- **Outside 8am to 8pm:** it is outside 8am–8pm in the customer's `timezone`, using `now`. The federal TCPA limit is 9pm. I used 8pm because Florida, Oklahoma, Maryland and Washington stop earlier. A blocked digest isn't recorded, so a later retry can still send it.
- **Bad time zone:** the zone is invalid, so quiet hours can't be checked. It fails closed.
- **Wrong channel or bad input:** the channel isn't "sms", `now` is invalid, or the user or message id is missing.

**`handleInbound`** returns `{ reply }`, and your app must send the reply text because I don't send anything.
- **Opt-out words:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, plus "stop …" messages like "Stop." or "stop please". Matching ignores case and punctuation. The customer is opted out and the reply confirms it. Opting out of the digest on the account page uses the same record as texting STOP.
- **HELP / INFO:** the reply gives help info and the STOP instruction.
- **START / UNSTOP / YES:** clears the opt-out and replies with a confirmation.
- **Anything else:** `{ reply: null }`.

**`optOut(userId, channel)`** writes a persistent opt-out record.

**Testing:** I ran a script against a temp `STATE_DIR` covering these checks, and all passed:
- a normal send, a duplicate, a night-time block followed by a successful retry, and a bad time zone;
- STOP, HELP and START round trips;
- `optOut` blocking later sends;
- 8 concurrent processes sending the same digest, where exactly 1 got `sent: true`;
- a restart still reporting the digest as already sent.

Things to check before launch:
- The code can't verify that a customer agreed to receive texts, because that isn't in the data you pass in. Your app must only call `trySend` for customers with recorded consent. Carriers also expect the signup flow to disclose the program and message frequency.
- `HELP_REPLY` uses the placeholder `support@example.com` and has no brand name. Put in your real program name and contact.
- There is no weekly frequency cap beyond the per-digest-id check. Two different digest ids in one week would both send.
- If a worker crashes after `trySend` returns `sent: true` but before the text goes out, that digest is never retried. I chose that over the risk of a double text.
