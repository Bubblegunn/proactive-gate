Wrote `bot.mjs` at `work/ours-g5-3/bot.mjs`. It exports `decideWhatsApp(message, now)`, is synchronous, and has no dependencies. All checks in a scratch test (outside the repo) pass. Nothing was sent or committed.

**Rules, in order:**
1. **Unknown `type`** → `unknown_message_type`.
2. **`optedIn !== true`** → `not_opted_in`. Applies to both types. Anything other than a literal `true` counts as no opt-in.
3. **Template** → allowed. Templates may go to an opted-in patient at any time, including with no inbound history.
4. **Text** needs an open 24-hour customer service window:
   - `lastInboundTimestamp` is `null` (never wrote to us) → `outside_service_window`.
   - Elapsed time ≥ 24 h → `outside_service_window`. Exactly 24 h is closed.
   - Not all digits, or the inbound time is after `now` → `invalid_inbound_timestamp`.
   - Otherwise allowed.

**Timestamp handling:** Meta's webhook `timestamp` is Unix seconds as a string, so the code does `Number(ts) * 1000`. Treating it as milliseconds would make every window look closed.

**Choices you may want to change:**
- A future inbound timestamp is rejected instead of tolerated for clock skew. A small skew can cause a brief false rejection, which is the safe direction.
- Malformed or non-finite values fail closed. A bad `now` also ends up as `invalid_inbound_timestamp`.

**Not verified:** I had no web access here, so the policy rules (24-hour customer service window, templates for business-initiated sends, opt-in requirement, seconds-based timestamps) come from my knowledge of the Cloud API docs, not a fresh read. Check them against the current Meta documentation before relying on this in production.
