`bot.mjs` is written and `node test.mjs` passes. It has no dependencies, so `package.json` is unchanged. The test sends nothing and covers the cases below.

**What `trySend` refuses, in order, each with a plain-sentence `reason`:**
- **Bad input:** the channel isn't "sms", the time is invalid, or the time zone is missing or invalid. A missing zone is refused, not guessed. The test caught that case: `Intl` silently used the server's zone, which I fixed.
- **Opted out:** the customer opted out, by text or on the account page.
- **Already sent:** the digest `message.id` was already recorded as sent. This covers redelivery and workers racing. 8 processes on the same message produced exactly one `sent: true`.
- **Outside sending hours:** it is outside 8:00–19:59 in the customer's own time zone. That is stricter than the federal 9pm limit because some states stop at 8pm. The caller should retry later.
- **Too soon:** the customer got a digest in the last 6 days. I used 6 rather than 7 so a digest delayed by sending hours doesn't block the next one.

A digest is recorded as sent before it leaves. If a worker crashes after `trySend` returns, that digest is lost but never sent twice. I chose that deliberately.

**`handleInbound` returns `{ reply }`.** It sends nothing itself. The app must send the reply when it isn't `null`.
- **Opt-out:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPTOUT count as opt-outs, case-insensitive. So do those words inside a sentence ("please stop texting me") and phrases like "opt out". It errs toward opting out. The reply confirms the unsubscribe.
- **Resubscribe:** START or UNSTOP turns texts back on.
- **Help:** HELP or INFO returns the help text.
- **Other texts:** anything else gets `null`, so we never text someone who opted out.

**State:** each customer has one JSON file in `STATE_DIR` (created if missing), changed under a per-customer lock and written atomically. It survives restarts. If a file is corrupt, `trySend` throws and sends nothing.

**Things to check:**
- **Consent:** the app gives me no consent record. I assume everyone who isn't opted out gave written consent when they signed up for texts. If that's not guaranteed, we need a consent flag passed in.
- **Digest text:** I can't see it. It should name the business and say "Reply STOP to opt out".
- **Reply wording:** the STOP, START and HELP replies don't name your business, and carriers expect a brand name. Edit those three constants at the top of `bot.mjs`.
- **Time zone:** the sending-hours check uses the profile time zone. If a customer moves, a number's area code may no longer match it.

I left `test.mjs` in the folder.
