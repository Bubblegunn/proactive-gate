`bot.mjs` is written and exports `planSends`. I also added `bot.test.mjs`, and all 10 tests pass (`node --test`). It was tested on Node v24.13; I didn't run it on Node 22.

**Rules, in the order they are checked.** Candidates are taken best-first by `priority`, and ties keep the input order.

| rule | holds | when |
|---|---|---|
| `invalid-candidate` | any | unknown category, non-finite priority, or bad `id` or `dedupeKey` |
| `promo-no-opt-in` | promo | `promoOptIn` is not `true` |
| `invalid-time-zone` | reminder, promo | quiet hours are set and the IANA zone is unknown |
| `invalid-quiet-hours` | reminder, promo | quiet hours are set but not in `HH:MM` form |
| `quiet-hours` | reminder, promo | the customer's local time falls in the window |
| `dedupe-7d` | any | the same `dedupeKey` was sent less than 7 days ago |
| `dedupe-in-batch` | any | a higher-priority candidate in this batch already took the key |
| `daily-cap-3` | reminder, promo | 3 reminders and promos have already been sent in the last 24 hours, counting history plus this batch |

**Decisions you may want to change:**
- **Promos and Apple.** Apple Guideline 4.5.4 forbids promotional push notifications without explicit opt-in. A candidate doesn't say whether it goes by push or in-app, so every promo needs `promoOptIn`. If in-app promos shouldn't need opt-in, the candidate needs a channel field.
- **Critical messages** skip quiet hours and the daily cap, and they don't count toward the cap. They still follow the 7-day `dedupeKey` rule, because your policy states it without exceptions. Make sure each distinct fraud alert has its own `dedupeKey`.
- **Quiet-hours edges.**
  - Windows that cross midnight (22:00–07:00) work.
  - Start is inclusive and end is exclusive.
  - Local time is taken from `timeZone`, so daylight saving is handled.
  - `start === end` is treated as no quiet hours.
  - An unknown time zone or malformed quiet hours fails closed: reminders and promos are held, and critical messages still go.
- **Windows.** The 24-hour and 7-day windows are exclusive at the boundary, so a message sent exactly 24 hours ago no longer counts. History entries with an unreadable `sentAt` are ignored.
- **A held candidate takes nothing.** It doesn't use up a dedupe key or a cap slot, so a lower-priority candidate can still go in its place.
- **A bad `now`** (not a valid Date) throws a `TypeError`.

**When you send:** pass the candidate's `dedupeKey` as Courier's `Idempotency-Key`, which the Courier docs recommend for security alerts. Courier send limits can't be set through the API, so keeping this cap in `planSends` is correct.
