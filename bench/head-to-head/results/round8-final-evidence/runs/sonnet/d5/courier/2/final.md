`bot.mjs` exports `planSends`. It is pure: no clock, no file reads, and it doesn't change its arguments. I also wrote `bot.test.mjs`; run it with `node --test`. All 8 tests pass on Node 24, and they include a check that the arguments are unchanged. I did not run it on Node 22.

**Rule identifiers**, one per reason, in the `rule` field of each `dropped` entry:
- `no-promo-opt-in`: a promo for a customer who has not opted in. Apple's App Store Review Guideline 4.5.4 forbids push promotions without opt-in.
- `dedupe-7d`: the same `dedupeKey` was sent within the last 7 days.
- `quiet-hours`: the customer's local time right now is inside their quiet hours.
- `frequency-cap`: 3 reminders and promos have already gone out in the rolling 24 hours.
- `duplicate-in-batch`: another candidate with the same `dedupeKey` and higher priority is going out in this run.
- `unknown-category`, `unknown-time-zone` and `invalid-quiet-hours`: bad input.

**Critical messages:**
- They skip the promo opt-in check, quiet hours and the 3-per-24h cap, and they don't count toward the cap.
- They still obey the 7-day `dedupeKey` rule, because your policy states it without exception. If you want a repeated security alert to go out anyway, that is a one-line change.

**Cap and ordering:**
- Critical sends don't use up the cap, and earlier critical sends don't count against it.
- `send` is sorted by `priority`, highest first. On a tie, critical comes first, then the order the candidates were given.
- When the cap is the limit, the lowest-priority reminders and promos are the ones dropped.

**Time handling:**
- Quiet hours use the customer's own time zone, so daylight-saving changes are handled. Windows that cross midnight, such as 22:00 to 07:00, work.
- The start time is inside the window and the end time is outside it.
- The edges are exact: a send exactly 24 hours or exactly 7 days ago no longer counts.

**Judgment calls to confirm:**
- If `start` equals `end`, I treat that as no quiet hours.
- If the time zone or quiet-hours values can't be parsed, non-critical messages are held and critical ones still go.
- A history entry with an unparseable `sentAt` counts as recent.
- A candidate whose `priority` isn't a finite number sorts last.
- Quiet hours are only checked at `now`. A message held for quiet hours is not rescheduled.
- The rule is per candidate, with no push versus in-app distinction, because candidates carry no channel. If in-app promos should be exempt from the opt-in rule, a `channel` field would be needed.
