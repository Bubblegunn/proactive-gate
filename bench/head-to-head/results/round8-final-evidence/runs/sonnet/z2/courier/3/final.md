`bot.mjs` is written in the current folder. My checks passed: a unit script for the individual rules, and a run with 12 processes sharing one `STATE_DIR`. In the multi-process run, exactly one process got `sent: true` for the same digest id and the other 11 were refused. It needs no dependencies, and the existing `package.json` already has `"type":"module"`. Nothing is sent. `trySend` only decides and records.

**`trySend`** returns `sent: false` with a short reason in each of these cases:
- **Duplicate id:** the digest id was already recorded as sent, which covers redelivery after a worker crash. Because the record is written before the actual send, a crash in between loses that digest instead of sending it twice.
- **Opt-out:** the user opted out, either on the account page or by text.
- **Quiet hours:** local time in the user's timezone is outside 8am–8pm. Federal TCPA allows until 9pm, but I used 8pm because some states are stricter and we only know the timezone, not the state.
- **Old digest:** `createdAt` is more than 48 hours old.
- **Too frequent:** the user already got a digest in the last 6 days.
- **Bad input or error:** the channel isn't `sms`, the timezone or other input is invalid, or the state files can't be read or locked. When in doubt it does not send.

**`handleInbound`** returns `{ action, reply }`, and the app has to send `reply` back to the customer.
- **Opt-out words:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT (case and punctuation ignored) record an opt-out and return the confirmation reply.
- **Free text:** phrases like "please stop texting me" and "don't text me" also opt the user out. This is deliberate, since FCC rules treat any reasonable wording as a revocation.
- **Resubscribe:** START, UNSTOP or YES clears a text opt-out. It does not override an account-page opt-out. In that case the reply tells the customer to turn texts back on in account settings.
- **Help:** HELP and INFO return a help reply with "Msg&data rates may apply" and how to stop.
- **Everything else:** `action: 'none'` with no reply.

**`optOut`** records the opt-out immediately, and it holds even if the customer later texts START.

**State and locking:** each user has one JSON file in `STATE_DIR`, written atomically and only under a per-user lock file. A lock older than 10 seconds is treated as left over from a crashed worker and removed. The opt-out check and the sent record happen under the same lock, so a STOP can't slip past a send in progress.

**Assumptions:**
- A user with no opt-out on record is treated as having already consented. The app wasn't giving me consent data, so the app must only call this for people who opted in.
- The reply texts say "Reminder bot" and point to the account Help page. You'll want to put in your real brand name and support contact.
- The limits (the 6-day gap, the 48-hour age cutoff and the 8am–8pm window) are constants at the top of the file.
