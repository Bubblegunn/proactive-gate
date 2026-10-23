`bot.mjs` is written and works. It has no dependencies, so `package.json` is unchanged. `trySend` only decides and never sends anything.

**What I ran:** one script that called the exported functions in a single process against a fresh `STATE_DIR`.
- A normal digest is allowed.
- A redelivered id is refused.
- Four parallel calls on one id produced one send.
- An invalid time zone is held.
- "STOP" blocks later digests, and "stopping" does not count as STOP.
- "START" turns texts back on, and `optOut` blocks again.

**What I did not check:** I did not run separate worker processes or restart a process. The claim and state writes come from the skill's tested helper code, so I relied on that.

**Rules in the file:**
- **Consent:** the app gives no consent field, and a weekly digest is a text the customer signed up for. It is allowed unless that customer has opted out of SMS.
- **Opt-out:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPT OUT match as the whole message. The opt-out is saved for that user and channel in `STATE_DIR`, and the account-page `optOut` writes the same record. START turns it back on. HELP and INFO get a short reply and change nothing. `handleInbound` returns `{ reply }`, and your app has to send that reply.
- **Duplicates:** each digest is claimed by user and message id before it is allowed. A redelivered or crashed-and-retried event returns `sent: false` with a duplicate reason. I chose this over repeating `sent: true` so the customer never gets two texts.
- **Time zone:** a missing or invalid zone holds the text. The code never guesses a zone.
- **Refusals:** each one is a plain sentence that names the rule. None has a retry time, because there are no time windows.

**Numbers I chose:**
- Quiet or calling hours: none.
- Weekly cap: none. The app's weekly generation sets the frequency.
- Redelivery claim: never expires.

**Not enforced:**
- **US calling hours (08:00 to before 21:00 local):** your request doesn't name a law, and a digest the customer signed up for isn't a promotion. If you want those hours, say so and I'll add them.
- **Opt-out notice in the message body:** a recommendation only. Adding "Reply STOP to unsubscribe" to each digest is cheap.
