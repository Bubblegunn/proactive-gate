Wrote `bot.mjs` and it passes my 19 checks. Nothing was sent, and I did not commit.

**Rule order and reason codes**

1. `unsupported_message_type`: type is not `text` or `template`.
2. `not_opted_in`: `optedIn !== true`. Applies to templates too.
3. Templates are allowed from here, even if the patient never wrote to us.
4. `no_prior_inbound_message`: free-form text and `lastInboundTimestamp` is null or missing.
5. `invalid_inbound_timestamp`: not digits only, or more than 5 minutes ahead of `now`. This catches millisecond values.
6. `customer_service_window_closed`: free-form text and 24 hours or more since the inbound message.
7. Otherwise `{ allowed: true, reason: null }`.

**Choices I made that you may want to change**

- The timestamp is read as Unix seconds, so it is multiplied by 1000 before comparing.
- Exactly 24 hours after the inbound message counts as closed. The window is open only while elapsed time is under 24 hours.
- A 5-minute clock-skew allowance covers timestamps slightly ahead of server time. Anything further ahead is rejected as invalid.
- If `now` is not a valid `Date`, the function throws `TypeError`. It does not return a decision.

**Sources and limits**

My web searches did not reach Meta's own pages. The 24-hour window and opt-in rules come from third-party docs: [360dialog overview](https://docs.360dialog.com/docs/messaging/overview), [AWS End User Messaging Social guide](https://docs.aws.amazon.com/social-messaging/latest/userguide/send-message.html), and [botdistrikt WhatsApp docs](https://docs.botdistrikt.com/whatsapp). The timestamp as Unix seconds is consistent across the results, but Meta's own inbound `messages` reference was not checked. Its JSON type (string or integer) is documented inconsistently across the results. The code accepts a numeric string, so it works either way. Please check Meta's current developer docs before relying on the window edge and the timestamp handling.

Meta also has rules about marketing messages to users who have not engaged recently. They need message history, which this check does not have, so they are not covered.

**Verification**

The tests are in `/tmp/bot-check/check.mjs`, outside the repo. They cover the window edges (23h59m59s open, exactly 24h closed), the no-inbound and opt-out cases, millisecond and non-numeric timestamps, and a future timestamp. Run them with `node /tmp/bot-check/check.mjs`. The first version of my test fixture used the wrong base time, which I fixed. The bot code did not change.
