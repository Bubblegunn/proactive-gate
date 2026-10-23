`bot.mjs` is written, and its 9 tests in `bot.test.mjs` pass under `node --test` (run on Node v24.13.0, not 22). Nothing is sent. The function reads no clock or file and leaves its arguments unchanged. The tests check that last point directly. The file also exports a `RULES` constant listing the rule ids below.

The `rule` ids you can read off a dropped message:

| `rule` | Why the message was held |
|---|---|
| `promo-not-opted-in` | It is a promo and `promoOptIn` is not `true`. Apple's App Store Review Guideline 4.5.4 forbids promotional push without explicit opt-in. I applied it to every promo, not only push. |
| `quiet-hours` | The customer's local time is inside their quiet window. |
| `duplicate-within-7d` | The same `dedupeKey` went out less than 7 days ago. |
| `duplicate-in-batch` | A higher-priority candidate with the same `dedupeKey` was already accepted. |
| `daily-cap` | 3 promos and reminders already went out in the last 24 hours, counting this batch. |
| `invalid-candidate` | Unknown category, non-numeric priority, or no `dedupeKey`. |
| `invalid-user-config` | The time zone or quiet hours are unusable. |

Where your spec left a choice, I made these calls:

- **Critical messages:** they skip the opt-in check, quiet hours and the 3-per-24-hours cap, and don't count toward it. I assumed fraud and security alerts should still reach people at night. They are still subject to the 7-day `dedupeKey` rule, because you said it applies to the same key. If a repeat security alert can share a key with an earlier one, use a distinct `dedupeKey` per event.
- **Quiet hours:** the window includes its start time and excludes its end time. It can wrap past midnight, for example 22:00 to 07:00. The customer's own time zone and daylight saving apply. A `start` equal to `end` means no window.
- **Bad time settings:** a bad time zone or malformed quiet hours holds non-critical messages and still lets critical ones through. I chose to fail closed rather than throw.
- **Ordering and cap:** `send` is sorted by `priority`, highest first, and ties keep input order. The cap goes to the highest-priority messages first. A message dropped for another reason, such as no opt-in, doesn't use up a cap slot or block a lower-priority duplicate.
- **Time boundaries:** a send exactly 24 hours or exactly 7 days ago no longer counts. A `now` that isn't a valid `Date` throws a `TypeError`. History entries with an unparseable `sentAt` are ignored.

I used the Courier skill's guidance on transactional messages and quiet hours for the critical-message calls. Courier's own delivery-window feature would be the way to defer a message to a later send time. This function only decides what may go out now.
