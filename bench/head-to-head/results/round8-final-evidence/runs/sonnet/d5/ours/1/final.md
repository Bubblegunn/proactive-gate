`bot.mjs` is written and exports `planSends`. My throwaway check script passes (script is at `/tmp/chk.mjs`, outside the repo). It covers:
- priority order, and the cap counting history from the last 24 hours
- 7-day dedupe, and quiet hours that wrap midnight with start included and end excluded
- a bad time zone, promo without opt-in, and a duplicate `dedupeKey` within one batch
- arguments and `now` left unchanged

**Rules and identifiers**
- `promo-no-opt-in`: a promo goes only if `promoOptIn === true`. Apple's guideline 4.5.4 bars promotional push without opt-in.
- `quiet-hours`: reminders and promos are held inside the window, in the customer's local time.
- `invalid-time-zone`: the zone is invalid and quiet hours are set, so a reminder or promo is held.
- `invalid-quiet-hours`: the quiet-hours times are malformed, so a reminder or promo is held.
- `dedupe-7d`: the `dedupeKey` appears in history within 7 days.
- `dedupe-same-batch`: a higher-priority candidate with the same `dedupeKey` was picked in this call.
- `cap-3-per-24h`: history already holds 3 reminders and promos in the last 24 hours, or this call filled the remaining slots. Slots go to the highest priority first.
- `unknown-category`: the category is not `promo`, `reminder` or `critical`.

**Choices I made where your spec was silent**
- **Critical messages:** they ignore quiet hours, the cap and the time zone, and they don't count toward the cap. They are still subject to the 7-day dedupe, so give each distinct alert its own `dedupeKey`. If you'd rather a critical alert always go, that is a one-line change.
- **Ordering:** `send` is sorted by `priority` only, so a critical message with a low number can come after a promo.
- **Equal start and end:** `quietHours` with equal start and end is treated as an empty window.
- **Cap count:** history entries dated in the future, and promos and reminders with a bad `sentAt`, are handled differently. Future-dated entries count toward the cap. Entries with an unparseable `sentAt` are ignored.
- **Bad `now`:** a non-Date or invalid `now` throws a `TypeError`.

The proactive-gate skill's default adds shared state files. I left that out because you asked for a pure function that reads no files, so `history` is the only state. I also didn't use its helper kit, which reads and writes files, so the time-zone and window logic is hand-written with `Intl`. I did not test DST transitions.
