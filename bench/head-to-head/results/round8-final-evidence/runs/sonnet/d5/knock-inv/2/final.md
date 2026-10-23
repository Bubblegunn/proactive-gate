`bot.mjs` is written and its 8 tests pass (`node --test bot.test.mjs`). Nothing was sent. The tests cover ordering, opt-in, quiet hours, the cap, dedupe, and that the arguments are not changed. I did not test an invalid time zone, a malformed `quietHours` value, or a DST transition.

Rules are checked in this order, and a candidate is dropped for the first one it fails:

| `rule` | Held because |
|---|---|
| `unknown-category` | The category is not promo, reminder or critical. |
| `promo-not-opted-in` | It is a promo and `promoOptIn` is not `true`. Apple guideline 4.5.4 forbids promotional push without explicit opt-in. |
| `quiet-hours` | It is not critical and the current local time is inside the customer's window. |
| `dedupe-7d` | The same `dedupeKey` was sent within the last 7 days. |
| `dedupe-in-batch` | A candidate with the same `dedupeKey` is already going out in this call. |
| `daily-cap` | Reminders and promos already number 3 in the last 24 hours, counting this call's sends. |

**Ordering:** `send` lists critical messages first, then higher `priority`, then input order. `dropped` keeps input order.

**Critical messages:** they skip quiet hours and the cap and do not count toward it. They are still subject to the 7-day dedupe, because you wrote that policy for all messages. If a repeat fraud alert must always go out, the caller needs a unique `dedupeKey` per event. Otherwise, tell me and I will exempt critical messages from dedupe.

**Quiet hours:**
- The start is inclusive and the end is exclusive.
- A window can cross midnight, for example 22:00 to 07:00.
- A window where start equals end is treated as no quiet hours.

**Time windows:** a history entry counts only if it is newer than exactly 24 hours (cap) or 7 days (dedupe) before `now`. Entries dated in the future also count.

**Bad input:** an invalid `now`, an unparseable `sentAt` or a malformed `HH:MM` throws a `TypeError`. An invalid `timeZone` throws a `RangeError`. The function does not guess in those cases.

Files are in `<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round8-final/d-sonnet/work/knock-inv-d5-2`:
- `bot.mjs`
- `bot.test.mjs`
