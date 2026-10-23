`bot.mjs` exports `planSends`, and the 10 tests I wrote in `bot.test.mjs` all pass with `node --test`. It doesn't read the clock or any file, and it doesn't change its arguments. A test checks the arguments and the `now` Date are unchanged afterwards.

**Rules and their ids.** Each candidate is checked in this order, and the first rule that fails is the one reported:
- `unknown-category`: the category isn't promo, reminder or critical.
- `promo-no-opt-in`: a promo for a customer without `promoOptIn`. Apple's guidelines require explicit opt-in for promotional push.
- `dedupe-7d`: the `dedupeKey` was sent less than 7 days ago. Exactly 7 days ago is allowed.
- `dedupe-same-batch`: a higher-ranked candidate in this batch already uses the same key.
- `quiet-hours`: the customer's local time is inside their window. The window includes the start and excludes the end, and it can wrap past midnight. The local time is computed with `Intl`, so DST is handled.
- `quiet-hours-unevaluable`: the time zone or the quiet-hours format is invalid, so the function can't tell whether it's quiet. It holds the message instead of throwing.
- `rate-limit-24h`: the customer already has 3 promos and reminders in the last 24 hours, counting this batch. A send exactly 24 hours ago no longer counts.

**Ordering.** `send` lists critical messages first, then higher `priority`, then input order. I put critical first so a high-priority promo can't be listed ahead of a fraud alert. If you want strict `priority` order, change the sort in `planSends`.

**Choices I made where your spec was silent:**
- Critical messages skip quiet hours and the 3-per-24-hours cap, and they don't count toward the cap. They still go through the opt-in and dedupe rules, since the dedupe rule was stated for all messages.
- A quiet-hours window where start equals end is treated as no window.
- A history entry with an unparseable or future `sentAt` is treated as sent right now, so it counts toward the cap and dedupe.
- Any history category other than critical counts toward the cap.

I didn't test `planSends` against your real data or call it from the assistant.
