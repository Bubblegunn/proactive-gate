`bot.mjs` is written and exports `planSends`. It reads no clock or file and doesn't change its arguments. I also wrote `bot.test.mjs`, and all 12 tests pass with `node --test`. Nothing is sent.

**Rule identifiers in `dropped`**, one per reason:
- `unknown-category`
- `promo-not-opted-in`
- `quiet-hours`
- `dedupe-7d`: the `dedupeKey` was already sent within the last 7 days.
- `dedupe-in-batch`: another candidate with the same `dedupeKey` ranked higher in this run.
- `daily-cap`

If several rules apply to one candidate, it gets the first in that order.

**Ordering:** `send` puts critical messages first, then higher `priority`, then the order they were passed in. Dropped candidates also keep their input order.

**Decisions I made where your spec was silent. Please confirm them:**
- **Promos:** a promo needs `promoOptIn`. I did this because Apple guideline 4.5.4 only allows promotional push messages with explicit opt-in.
- **Critical messages:** they skip quiet hours, the opt-in check and the 3-per-24h cap, and they don't count toward the cap. Fraud and security alerts shouldn't wait for morning.
- **Critical dedupe:** critical messages still obey the 7-day `dedupeKey` rule, because you said "the same `dedupeKey`" without exceptions. If a security alert repeats under the same key within a week, it is held. Say so if you want critical exempt.
- **Quiet hours:** they are read in the customer's `timeZone`, including windows that cross midnight, such as 22:00 to 07:00. The start is inclusive and the end is exclusive. A window where start equals end counts as no quiet hours.
- **Window edges:** a send exactly 24 hours ago no longer counts toward the cap, and a send exactly 7 days ago no longer blocks a repeat.
- **Cap counting:** only history entries with category `promo` or `reminder` count. Candidates dropped for any other reason don't use up cap slots.
- **Bad input:** an invalid `timeZone`, malformed `HH:MM` or unparseable `sentAt` throws instead of guessing. That way a bad record can't quietly let a message through.
