`bot.mjs` is written and passes my self-check. It exports `trySend`, `handleInbound` and `optOut`. I added no dependency and nothing is actually sent.

**What the self-check covered** (run against a fresh `STATE_DIR`, with a single process except for the race test):
- A first digest is allowed.
- A redelivered message id is refused, so the text is not sent twice.
- A second digest in the same local week is refused. The reason includes the retry time as a local clock time with the zone name, and `nextAllowedAt` carries the same instant.
- A digest in the following week is allowed.
- An invalid time zone is held.
- Four concurrent calls for one message id gave exactly one `sent: true`. I ran these as concurrent calls in one process, not as separate worker processes.
- STOP, START and HELP work as the whole message, with punctuation and case ignored.
- A STOP from a text, or `optOut` from the account page, blocks the next digest. START turns it back on.

**Not checked:**
- Concurrency across separate worker processes.
- A restart. State is stored in files and read on every call, but I didn't run a restart test.
- DST edges.

**Numbers I chose:**
- Limit: one digest text per customer per week, counted in the customer's own local week. I took this from "weekly digest", so a second digest in that week is held.
- Quiet hours and legal hours: none. You gave no window, and a digest the customer signed up for is not a promotion. If you want the US 08:00–21:00 window anyway, say so and I'll add it.
- Consent: no consent field exists in the data you gave me, so I treated the digest as opted in until a STOP or account-page opt-out is recorded. The opt-out is kept per customer and channel.

**Redelivery answer:** a redelivered message id returns `sent: false`, not the original `sent: true`, because returning `sent: true` again would send the text twice. If a worker crashes after `trySend` allowed the text, the id stays claimed, so that digest is never retried. I chose this because losing one digest is safer than texting someone twice.

**Other behaviours:**
- `handleInbound` returns `{ action, reply }`. The app has to send the reply text itself.
- `handleInbound` ignores other messages and returns `action: "none"`.
- If a customer sends STOP while a digest is being checked, a second opt-out check right after the claim catches it in most cases. A text could still go out if the STOP lands after that check.
