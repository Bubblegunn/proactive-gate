Wrote `bot.mjs` in the working directory. It exports `decideWhatsApp(message, now)`, is synchronous, has no dependencies, and sends nothing. All checks pass when run against it, and it only uses Node 22 features.

**Rules, in order:**
1. **Not opted in** (`optedIn !== true`) → `contact_not_opted_in`. This applies to every message type.
2. **Template** → allowed. Approved templates can go to an opted-in contact at any time.
3. **Other type than text/template** → `unknown_message_type`.
4. **Text, contact never wrote to us** (`null`/missing) → `no_inbound_message_service_window_closed`.
5. **Text, `lastInboundTimestamp` is not a valid timestamp** → `invalid_inbound_timestamp`.
6. **Text, 24 hours or more since the patient's last message** → `service_window_expired`.
7. Otherwise → allowed, `reason: null`.

**Timestamp handling:** Meta sends Unix time in seconds as a string, so `"1767272400"` is read as seconds and multiplied by 1000. Values that are numbers, non-digit strings, or millisecond-sized (≥ 1e11 seconds) are rejected. Without that bound, a millisecond value would read as a date tens of thousands of years ahead and keep the window open forever. A timestamp more than 5 minutes ahead of our clock is also rejected. Within 5 minutes it is accepted to allow for clock skew.

**Choices you may want to change:**
- The window is open while elapsed time is strictly under 24 hours. At exactly 24 hours it is closed.
- `undefined` for `lastInboundTimestamp` is treated the same as `null`.
- An invalid `now` (not a valid Date) throws a `TypeError`. It is a programmer error, not a message decision.
- The 24-hour free-form window and the template exception come from my knowledge of the Cloud API docs. I did not check them against the current Meta documentation in this session, so verify them before relying on them in production.

**Verification:** I ran assertions covering each rule, the window boundary, the opt-in-first ordering, bad timestamps (including millisecond and future values), invalid `now`, and that the reason codes are distinct. All passed. The check script was in `/tmp` and I deleted it afterwards, so `bot.mjs` is the only file I added.
