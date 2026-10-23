I wrote `bot.mjs` in the current folder. My test script passed. It covered 8 worker processes racing on one digest, redelivery, quiet hours, the weekly cap, STOP/START, and an account-page opt-out. Nothing is sent, and no dependency was needed.

**`trySend` returns `sent: false` with a plain reason when any of these apply:**
- **Duplicate:** this digest `message.id` was already recorded as sent. This covers queue redelivery and a worker that crashed and retried.
- **Opted out:** the customer opted out on this channel.
- **Quiet hours:** the customer's local time is outside 8am to 8pm. I used 8pm instead of the federal 9pm because some states (FL, OK, MD, WA) are stricter, and we only know the time zone, not the state. If the time falls in quiet hours, the digest is not sent. The queue has to retry it later, because the bot does not reschedule anything.
- **Weekly cap:** a digest went to this customer in the last 6 days.
- **Bad input:** the time zone is invalid, the channel isn't "sms", or an id is missing.
- **State error:** the state file can't be read or is corrupt. It fails closed, so nothing is sent.

If none apply, it records the send and returns `sent: true`.

**`handleInbound`:**
- **Opt-out:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT and REVOKE opt the customer out. Phrases like "please stop texting me" and "don't text me" also count. I made that match deliberately broad, because under the FCC's revocation rules a missed opt-out is worse than an extra one.
- **Re-subscribe:** START or UNSTOP turns the digest back on.
- **HELP:** HELP and INFO get a help reply.
- **Return value:** it returns `{ reply }`. You send the reply yourself, since the bot never sends. `reply` is null for any other text.

**`optOut(userId, channel)`** records the opt-out. It takes the same lock as `trySend`, so once it returns, no later `trySend` can return true.

**State:** `$STATE_DIR/state.json` is written atomically behind a lock directory, so it survives restarts. A lock left by a crashed worker is cleared automatically.

**Things you should decide or check:**
- The code can't verify consent. It assumes the app only calls `trySend` for customers who agreed to texts. If you don't record that consent anywhere, that is a TCPA gap.
- The reply texts have no brand name or support contact. Carriers expect those in the HELP reply, so please add them.
