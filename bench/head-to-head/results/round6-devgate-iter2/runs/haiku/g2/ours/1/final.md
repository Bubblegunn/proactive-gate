`bot.mjs` is written at `work/ours-g2-1/bot.mjs`. It exports `createPushGate()`, which returns `{ attempt(user, now) }`. Nothing is sent.

Checks run, all as expected:
- Quiet hours: 22:00 is quiet and 07:00 is allowed. The window wraps past midnight and works across a DST change.
- Daily cap: the 4th send on the same local day returns `daily_cap_reached`. The count resets at the user's local midnight.
- Bad input: an invalid zone, a malformed `HH:MM`, a non-integer cap, and an invalid `Date` each return their own code.
- Independence: a second `createPushGate()` instance has its own history.

I ran the checks on Node v24.13.0, not Node 22. The code uses only standard features, but I have not tested it on Node 22.

Reason codes, one per rule: `quiet_hours`, `daily_cap_reached`, `invalid_user`, `invalid_time`, `invalid_time_zone`, `invalid_quiet_hours`, `invalid_daily_cap`.

Choices I made:
- **Day** means the user's local calendar date in their IANA zone, not a rolling 24 hours or UTC.
- **Quiet window**: the start minute is quiet and the end minute is not. If `quietStart` equals `quietEnd`, there is no quiet period. Tell me if you want that to mean all day instead.
- **Cap counts only allowed sends.** `dailyCap: 0` refuses everything for that day.
- **Missing or invalid fields hold the send.** I did not guess defaults for them.
- **Order of checks**: user, time, zone, quiet hours, then cap.
- **Memory**: history is kept per user and pruned after 3 days.
- **Not added**: no minimum gap between pushes. You didn't ask for one, so I left it out.
