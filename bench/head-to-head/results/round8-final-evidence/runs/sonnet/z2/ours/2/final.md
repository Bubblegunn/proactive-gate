`bot.mjs` is written in the current folder and exports `trySend`, `handleInbound` and `optOut`. It needs no dependencies, so `package.json` is unchanged. Nothing is sent. The gate only decides.

**What I ran**
- **Single-process check:**
  - A first digest is allowed.
  - A redelivered digest is refused as already handled.
  - An invalid time zone is held.
  - " stop. " opts the customer out, and the next digest is refused.
  - "stopping" changes nothing.
  - START re-enables texts.
  - `optOut` blocks the next digest.
- **Concurrency check:** 8 worker processes sent the same message id at once, and exactly 1 got `sent: true`.
- **Not checked:** a crash and restart. State is written to files, so it should survive, but I did not test it.

**How it behaves**
- **Redelivery:** a message id that was already allowed comes back as `sent: false` with "already handled", so the text never goes out twice.
- **Opt-out:** it is kept per user and channel in `STATE_DIR`, shared by all workers, and it beats every other rule.
  - STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPT-OUT and OPTOUT count only when they are the whole message, in any case and ignoring outer punctuation.
  - START or UNSTOP turns texts back on. HELP gets a reply and changes nothing.
  - `handleInbound` returns `{ reply }`, which your app has to send. It sends nothing itself.
- **Time zone:** a missing or invalid zone holds the text. Refusals are plain sentences.

**Choices to check**
- **Consent:** there is no consent field, and the digest is something customers signed up for. So it is allowed unless an opt-out is recorded. Not enforced: opt-in, because the interface carries none.
- **Hours window:** I added none. You named no law and no quiet hours, so there is no 8am–9pm limit, and a digest can go at 3am recipient-local. If you want the US calling-hours window, say so. It is a small addition.
- **Weekly cap:** I added none. The only guard is one send per message id.
- **Message body:** I did not check the text for a STOP notice, because nothing you gave requires it. Not enforced: the body check.
- **Numbers I chose:** no hours, caps or cooldowns.
