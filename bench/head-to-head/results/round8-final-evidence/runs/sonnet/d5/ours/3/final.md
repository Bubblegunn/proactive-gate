`bot.mjs` is written and exports `planSends`. It is pure: it reads no clock or file and doesn't change its arguments. A throwaway script in `/tmp`, not in the repo, passed. It covered:
- priority order and the cap
- the quiet-hours start and end minutes
- an invalid time zone
- a promo without opt-in
- the 24-hour and 7-day boundaries
- unchanged arguments

I did not use the skill's default of a shared state directory, because you asked for a pure function. The `history` argument is the only state.

**Rules and drop identifiers**

| Rule | Behavior |
|---|---|
| `unknown-category` | The category is not `promo`, `reminder` or `critical`. |
| `dedupe-7d` | The same `dedupeKey` was sent in the last 7 days. This applies to every category, critical included. |
| `promo-no-opt-in` | A promo is held unless `promoOptIn === true`. Apple expects consent before marketing push. |
| `invalid-time-zone` | A bad zone holds promos and reminders; I never guess a zone. |
| `invalid-quiet-hours` | Malformed `HH:MM` holds promos and reminders. |
| `quiet-hours` | The window includes its start minute and excludes its end minute, in the customer's local time, and wraps past midnight when start is later than end. |
| `dedupe-same-batch` | Two candidates share a `dedupeKey`; the higher priority wins. |
| `cap-3-per-24h` | At most 3 promos and reminders per rolling 24 hours, counting history first. |

**Behavior to check**
- **Critical messages:** they skip the opt-in check, quiet hours, the zone checks and the cap, and they don't count toward the cap. Dedupe still applies to them. If a repeated fraud alert reuses a `dedupeKey`, it will be held for 7 days.
- **Ordering:** `send` is sorted by `priority` descending, with ties kept in input order. The cap fills from the best candidates down, and a held candidate doesn't use up a cap slot or claim its key.
- **Window edges:** a send exactly 24 hours or 7 days before `now` no longer counts. A `quietHours` where start equals end is treated as no window.
- **Bad history:** a history entry with an unreadable `sentAt` counts as recent, which errs toward holding.
- **Bad `now`:** an invalid `now` throws a `TypeError`.

The `rule` identifiers are the strings in the table above.
