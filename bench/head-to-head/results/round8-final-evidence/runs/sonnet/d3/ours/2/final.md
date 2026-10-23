`bot.mjs` is written and passes my checks. It exports `reserve({ userId, timeZone, channel, now })`.

**How it works**
- The cap is 2 marketing messages per customer per local day, counting sms, email and push together.
- The local day runs midnight to midnight in the customer's `timeZone`, worked out from the `now` you pass in. The system clock is never read.
- The count lives in files under `STATE_DIR`, which is read on every call and created if missing. Updates are atomic, so concurrent workers cannot both take the last slot. The count survives restarts.
- When a message is held, `rule` is one of:
  - `daily-cap`
  - `invalid-time-zone`
  - `invalid-channel`
  - `invalid-user`
  - `invalid-time`
- When a message is allowed, `rule` is `""`.
- A held message does not use up any of the 2 slots.
- If `STATE_DIR` is not set, the function throws.
- Appended to the file is the helper kit from the proactive-gate skill; it provides the time-zone and atomic-count functions. Nothing is sent.

**What I checked**
- Six simultaneous calls from one process for one customer: 2 allowed, 4 held with `daily-cap`.
- Six separate Node processes at the same time: 2 allowed, 4 held.
- A new process after that still holds the third message.
- The same customer in Tokyo is allowed again at 00:00 Tokyo time.
- The same instant in New York counts as a different day.
- A bad time zone is held.

**What I didn't check or handle**
- **Opt-out and consent:** the function has no opt-out or consent data to read, so it doesn't check them. A customer who has opted out must be filtered before `reserve` is called.
- **Redelivery:** it has no message id, so a retried call for the same message counts again.
- **Crash after allowing:** if a worker gets `allowed: true` and then crashes before sending, that slot stays used.

**Logs:** the held reason comes back in the return value, so the sender can log it with the user and time to show which message was held.
