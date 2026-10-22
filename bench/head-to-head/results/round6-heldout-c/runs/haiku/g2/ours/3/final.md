I wrote `bot.mjs` in the work directory and checked it with 16 inline cases, all passing. Nothing is sent.

**How it decides**
- **Transactional** (courier, security code): always sent. It skips the marketing cap and quiet hours, and it is not counted toward the cap.
- **Marketing**, checked in this order:
  1. **Quiet hours**: the customer's local time is compared with their `quietStart`/`quietEnd` in their IANA zone. Start is inclusive, end is exclusive, and a window with start later than end wraps past midnight. Blocked with `quiet-hours`.
  2. **Daily cap**: at most 3 sent per customer-local calendar day. The 4th is blocked with `daily-cap`. A send is counted only when `decide` returns `send: true`.
- Bad input is held, never guessed: unknown zone (`invalid-timezone`), malformed or missing window (`invalid-quiet-window`), unknown category or user id (`invalid-candidate`). An invalid `now` throws, because that is a caller bug.

**Choices you should check**
- **Quiet hours do not apply to transactional.** Your brief only exempted transactional from the cap, and it is not clear whether a security code at 03:00 should wait. If quiet hours should also hold transactional pushes, that is a one-line change, but a courier or security-code message would then be delayed overnight.
- **Quiet hours are checked before the cap**, so a push held for quiet hours does not use up that day's cap.
- **State is in memory only**, as you asked. A restart resets the counts, so a customer can get up to 3 more marketing pushes after a restart on the same day. The module has no shared store, so with more than one worker process each process keeps its own counts.
- **Memory is pruned** to today, yesterday and the day before, per customer, to bound growth.
- **Both checks run synchronously**, so there is no race between calls within one process.

**Self-check**: the cases covered the cap and its reset at the local day boundary, a New York customer whose local day differs from UTC, wrap-around quiet hours with both edges, transactional bypass, cap isolation between users, and the invalid-input holds. Note that this sandbox runs Node v24.13.0, not Node 22. The code uses nothing newer than Node 22 supports, but I did not run it on Node 22.
