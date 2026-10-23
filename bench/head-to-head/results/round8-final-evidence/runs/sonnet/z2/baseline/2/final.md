`bot.mjs` is written and tested. It needs no dependencies, so `package.json` is unchanged. Nothing was actually sent.

**What `trySend` checks**, in this order:
- **Bad input:** it refuses an invalid `now`, a channel other than `"sms"`, a bad `createdAt`, or a digest older than 48 hours.
- **Time zone:** it refuses an invalid time zone, because quiet hours can't be checked without one.
- **Opt-out:** a customer who opted out gets nothing.
- **Redelivery:** a message `id` already recorded as sent is refused.
- **Quiet hours:** it sends only from 8:00 to 20:59 in the customer's own time zone (the US 8 am–9 pm calling-hours limit), using `now`.
- **Weekly cap:** one digest per customer per 6 days. I used 6 rather than 7 so a digest that lands a few minutes early next week isn't blocked.
- **Failures:** any error, including a corrupt state file, returns `sent: false`.

When all checks pass, the send is recorded as sent before `trySend` returns.

**`optOut` and `handleInbound`:**
- `optOut` writes the opt-out to disk, and it is honored immediately.
- `handleInbound` treats these words as an opt-out: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT. It matches them case-insensitively, ignores punctuation, and accepts them inside messages of up to 4 words, such as "stop please".
- HELP returns help text, and START or UNSTOP re-subscribes.
- It returns `{ action, reply }`, where `reply` is the single text you may send back, or `null`. It never sends anything itself.

**Concurrency and restarts:** state lives in `STATE_DIR/state.json`. Workers take a lock directory around each read-and-write, and the file is replaced atomically, so state survives a restart.

**What I ran:**
- **Single process:**
  - redelivery and the weekly cap
  - quiet-hour edges in New York and Los Angeles
  - a bad time zone
  - opt-out variants, START, HELP, and `optOut` followed by `trySend`
- **8 parallel processes, same message `id`:** exactly 1 sent.
- **8 parallel processes, same customer, different `id`s:** exactly 1 sent.
- **Fresh process after the above:** the same message `id` was still refused.

**Gaps and assumptions:**
- A customer is assumed to have consented unless they opted out. The app gives me no consent data, so you need to record consent at signup.
- `trySend` can't change the message text. The digest itself should name your business and say "Reply STOP to opt out", and I can't check that.
- If a worker crashes after `trySend` returns true but before the text goes out, the redelivery is refused. That follows your "recorded as sent" rule: the cost is a missed digest, not a duplicate.
