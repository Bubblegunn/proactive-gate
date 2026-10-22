`bot.mjs` is written at `work/ours-g2-2/bot.mjs`. It exports `decide(candidate, now)` and returns `{ send, rule }`. Nothing is sent. The inline self-check passes (Node v24.13.0 on this machine, which satisfies Node 22+).

**Behavior**
- **Daily cap:** 3 marketing pushes per customer per local calendar day. The 4th returns `{ send: false, rule: "daily-cap" }`. Only sent marketing pushes count. Transactional pushes skip the cap and are not counted.
- **Quiet hours:** start is included, end is excluded, and a window where start > end wraps past midnight. The local time comes from `Intl` in the customer's IANA zone, so the server's UTC clock is not used.
- **Refusal rules:** `quiet-hours`, `daily-cap`, `invalid-timezone`, `invalid-quiet-window`, `invalid-category`, `invalid-user`, `invalid-time`.

**Choices you should check**
- **Quiet hours apply to transactional pushes too.** Your brief only exempts transactional from the cap. I read the quiet window as the customer's own do-not-disturb, so a courier message during it is held with `quiet-hours`. If couriers must always get through, remove the quiet check for `transactional`. It is one line.
- **Equal `quietStart` and `quietEnd` is held** (`invalid-quiet-window`), because it could mean empty or all-day and I did not want to guess.
- **State is in memory only**, as you asked. Counts for past days are dropped when a later day is seen. An out-of-order call for an earlier day after that would not be counted correctly. This is an edge case I did not handle.
- **No redelivery protection.** The candidate has no message id, so a retried call is counted again. Add an id field if retries are possible.
- **No consent check.** The candidate has no consent field, so the module does not check whether a customer opted in to marketing. Add one if the product needs it.

**Self-check results**
- Three marketing pushes at noon Istanbul time are sent; the fourth is `daily-cap`.
- A transactional push at noon is sent after the cap is hit.
- 23:30 Istanbul is `quiet-hours` for both categories.
- The window start (22:00) is held; the window end (07:30) is sent.
- At 00:00 on the next local day, the cap resets.
- An invalid zone returns `invalid-timezone`.

Two of my own test expectations were wrong on the first two runs. I corrected them and reran the full check. The module code did not change.

I did not use the proactive-gate library. You asked for one standalone module, and the library's policy and state machinery would have been more than that needs.
