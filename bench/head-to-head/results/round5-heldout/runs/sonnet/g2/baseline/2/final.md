`bot.mjs` is written and exports `createPushGate()`. My check script (`/tmp/gate-check.mjs`, outside the repo) passed. It covers Tokyo and New York cases, including the DST spring-forward day and local-midnight rollover.

`attempt(user, now)` checks these rules in order and returns the first one that blocks:

1. **`quiet_hours`**: the user's local time, in their `timeZone`, falls in `[quietStart, quietEnd)`. A window that runs past midnight works. If start equals end, I treat it as no quiet period.
2. **`daily_cap_reached`**: the user has already had `dailyCap` pushes on their local calendar day. "Per day" means their own midnight-to-midnight, not a rolling 24 hours and not UTC. Blocked attempts don't count toward the cap.
3. **`too_soon_after_last_push`**: the last push was less than 30 minutes ago. Without this, the agent could use the whole cap in one burst, which Apple and Google guidance warns against. The 30 minutes is my own choice, set by the `MIN_GAP_MS` constant. You didn't specify a gap, so change it if you want a different one.

Bad input is blocked rather than sent. An invalid `now` gives `invalid_time`. A bad zone, bad `HH:MM`, bad `dailyCap` or missing id gives `invalid_user_settings`. A `dailyCap` of 0 blocks everything with `daily_cap_reached`.

Each gate keeps its own history in memory and uses the settings passed on each call. It drops history older than 3 days, so memory stays bounded.

Nothing was sent.
