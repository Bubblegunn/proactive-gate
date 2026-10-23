`bot.mjs` is written and passes my check script (`/tmp/bot-check.mjs`, outside the repo). The script covers ordering, the cap, quiet-hour edges, both history windows, the promo opt-in, an invalid zone and a no-mutation check.

I did not use the proactive-gate skill's file-based state or its helper kit. You asked for a pure function that reads no clock or file, so the function derives everything from its arguments. It uses only `Intl` for local time and never calls `new Date()` without an argument.

**Rule identifiers**
- `unknown-category`: the category is not promo, reminder or critical.
- `promo-no-opt-in`: a promo for a customer whose `promoOptIn` is not exactly `true`. Apple's App Store Review Guidelines (4.5.4) require explicit opt-in for promotional push, so I treated missing as off.
- `quiet-hours`: the customer's local time is inside their window. The start minute is included, the end minute is excluded, and a window like 22:00–07:00 wraps past midnight.
- `invalid-time-zone`: the zone name is bad and `quietHours` is set, so the function can't tell whether it is quiet hours. It holds the message instead of guessing.
- `invalid-quiet-hours`: a quiet-hours time is not a valid "HH:MM".
- `dedupe-7d`: the same `dedupeKey` was sent in the last 7 days.
- `duplicate-in-batch`: another candidate with the same `dedupeKey` ranks higher in this batch.
- `rolling-24h-cap`: three reminders and promos have already gone out in the last 24 hours, counting this batch.

**Choices I made**
- Critical messages skip quiet hours, the promo opt-in check and the cap, and they don't count toward the cap. Dedupe still applies to them. Security alerts need distinct keys per event, or a repeat within 7 days will be held.
- `send` lists critical messages first, then higher `priority` first. Ties keep input order.
- Held messages never use up cap slots, so a lower-priority message can take a slot that a held higher-priority one didn't.
- Quiet hours of `start == end` mean no window at all.
- A history entry with an unreadable `sentAt` counts as recent, which holds more.
- `quietHours: null` means no quiet hours. A bad zone is only a problem when `quietHours` is set, because otherwise the zone is never used.
- The function throws a `TypeError` if `now` is not a valid Date.

The check script does not cover DST transitions, and it never calls `planSends` with `quietHours: null` and an invalid zone together.
