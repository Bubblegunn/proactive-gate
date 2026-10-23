`bot.mjs` is written and tested. It uses no dependencies, so `package.json` is unchanged. A script run outside the project folder passed all its checks, and nothing was actually sent.

**What the checks covered**
- Twelve processes sending the same message at once: exactly one got `sent: true`.
- A repeat of an already-sent message id is refused.
- Quiet hours and the Sunday rule are enforced.
- A second digest within the same week is refused.
- Opt-out and re-subscribe work, using `STOP`, `Unsubscribe`, "please stop texting me" and "don't text me".
- An unknown timezone and a stale digest are both refused.

**What `trySend` refuses**
It returns `{ sent: false, reason }` for each of these:
- **Opted out:** the user opted out of texts.
- **Repeat send:** the same `message.id` was already recorded as sent. This covers redelivery and worker crashes.
- **Quiet hours:** outside 9:00–20:00 in the user's local time, with Sundays starting at 12:00. Federal TCPA rules allow 8:00–21:00, but Florida, Oklahoma and Maryland stop at 20:00 and Texas allows Sunday texts only from noon, so this is deliberately stricter.
- **Weekly cap:** a different digest was already sent to this user in the last 6 days. The extra day allows for jitter in the weekly schedule.
- **Stale digest:** `createdAt` is more than 48 hours old.
- **Bad input:** the channel isn't "sms", the timezone isn't valid, or `now` or `createdAt` can't be parsed.

When quiet hours refuse a digest, nothing is recorded, so the queue can retry later.

**State handling**
State is one file per user in `STATE_DIR`. A per-user lock lets the worker processes share it, and a lock left behind by a crashed process is cleaned up.

**Opt-outs**
- **Opt-out words:** `handleInbound` treats `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `OPTOUT` and `REVOKE` as opt-outs when they are the whole message. It also catches natural phrases like "stop texting me". That follows the 2025 TCPA rule that any reasonable opt-out wording counts.
- **Re-subscribe:** only `START` and `UNSTOP` switch texts back on.
- **Return value:** it returns `{ action, reply }`, where `reply` is the confirmation or `HELP` text for your app to send. `HELP` and `INFO` get the help text.
- **Account page:** `optOut(userId, channel)` records the same opt-out.

**What you need to handle**
- **Consent:** I assumed users already agreed to receive texts from the bot. The code can't check that. If the digest has promotional content, or the original consent covered only reminders, get consent for the digest first.
- **Message body:** the first digest should name your service and say "Reply STOP to unsubscribe". Keep each text within 160 characters of plain characters, because an emoji drops the limit to 70.
