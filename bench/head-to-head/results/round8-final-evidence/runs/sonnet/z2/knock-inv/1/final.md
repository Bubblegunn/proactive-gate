`bot.mjs` is written in the current folder, and my test script passes. It needs no dependencies and `package.json` is unchanged. Nothing is sent.

`trySend` returns `sent: false` with a plain-sentence reason in these cases, checked in this order:
- **Opt-out:** the customer replied STOP, or turned the digest off on the account page.
- **Redelivery:** the same `message.id` was already sent. A crash after recording but before sending loses that one text, because I chose that over a duplicate.
- **Stale or bad timestamp:** the digest is more than 24 hours old, or `createdAt` is invalid or in the future.
- **Quiet hours:** local time is outside 8am–8pm. I used 8pm instead of the federal 9pm because Florida, Oklahoma and Maryland stop at 8pm. A missing or invalid timezone also blocks the send.
- **Weekly limit:** a digest went out less than 6 days ago. I allowed a day of slack for jitter.

When all of those pass, the send is recorded as sent.

- **Inbound texts:** `handleInbound` returns `{ reply }`, the text to send back, or `null`. You send the reply; the bot doesn't.
  - **STOP:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT and REVOKE match as the whole message. Phrases like "please stop texting me" also count. The reply is a confirmation, and no more digests go out.
  - **START:** START and similar words resubscribe, but only after a text STOP. They never override an account-page opt-out.
  - **HELP:** HELP and INFO get a help reply.
- **Account page:** `optOut(userId, channel)` blocks the digest permanently. The account page has no way to turn it back on in this API.
- **Concurrency and restarts:** state is one JSON file per user in `STATE_DIR`, behind a per-user lock, so opt-out and sends can't race across workers. A lock left by a crashed worker is reclaimed after 10 seconds.

What I tested:
- **Rules:** each rule above, including time-zone cases and a restart in a fresh process.
- **Concurrency:** 12 processes racing on the same event, and 12 racing on different events for one user. Exactly one send got through each time.
- **Not covered:** I didn't test a crashed lock holder or a STOP arriving mid-send.

Things I couldn't do from the data you gave me:
- **Consent:** `trySend` can't check that the customer opted in to texts. The app should only call it for customers with recorded consent, and TCPA requires you to keep that record.
- **Message text:** the digest text itself is yours. Name your service in it and add "Reply STOP to opt out" with a short opt-out line.
- **HELP reply:** it is generic. Add your company name and a support contact.
