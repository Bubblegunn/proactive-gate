`bot.mjs` is written and passes my check script. It has no dependencies, so `package.json` is unchanged. The check script covers the cases below and is at `/tmp/botcheck.mjs`, outside the project folder. Nothing is actually sent.

**`trySend`**
- **Quiet hours:** it refuses outside 8am–9pm in the customer's time zone, using `now` and not `createdAt`. DST is handled. An unknown time zone also means no send, because quiet hours can't be checked.
- **Opt-out:** it refuses if the customer has opted out.
- **Duplicates:** each `message.id` is sent at most once, across worker processes and restarts. I started 8 processes on the same id and exactly one sent.
- **Failure handling:** missing ids, a channel other than "sms", a bad `now`, or unreadable state all mean no send, with a plain-sentence `reason`.
- **Lost sends:** a send is recorded before the text goes out. If a worker crashes after `trySend` returns true but before the text leaves, the redelivery is blocked, so that digest is lost. I chose that over a possible double text.

**`handleInbound`** returns `{ action, reply }`. `reply` is the one text to send back, or `null`.
- **Opt-out:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPTOUT opt the customer out, as do phrases like "please unsubscribe me" or "do not text". It matches on whole words anywhere in the message, so a message containing "end" in a sentence also opts out. I did that on purpose, since the FCC's revocation rule requires honoring any reasonable opt-out wording. The reply confirms the opt-out once. If they were already opted out, there is no reply.
- **Opt back in:** START or UNSTOP, as the whole message, subscribes them again.
- **Help:** HELP or INFO returns a help text. Any other message gets no reply.

**`optOut(userId, channel)`** records the opt-out immediately. The opt-out and the sent-record share one lock, so a send can't slip past an opt-out that is happening at the same moment.

**Limits**
- **Consent:** the code has no consent record, so it assumes the app only calls it for customers who agreed to texts. It also doesn't control message text, so the digest itself should name your business and say "Reply STOP to opt out". The reply texts in `bot.mjs` are generic and have no brand name.
- **State rules:** I used the federal 8am–9pm window. Some states are stricter, for example Florida and Oklahoma stop at 8pm. A time zone can't tell me the state. If you want to be safe, move the window to something like 9am–8pm by changing `QUIET_START_HOUR` and `QUIET_END_HOUR`.
- **Weekly cap:** there is no cap on how many digests a customer gets per week. Duplicates are caught only by event id.
