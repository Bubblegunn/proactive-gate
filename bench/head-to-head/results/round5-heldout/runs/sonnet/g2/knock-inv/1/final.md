`bot.mjs` is written and exports `createPushGate()`. My throwaway test script, which sent nothing, passes. It lives at `/tmp/t.mjs`, outside the project.

**How it decides.** `attempt(user, now)` checks the rules in this order:

1. **Invalid settings → `invalid_settings`.** This covers a bad time zone, a malformed `HH:MM`, a non-integer or negative `dailyCap`, or a bad `now`. It fails closed, because skipping a push costs less than waking someone.
2. **Quiet hours → `quiet_hours`.** The time is read on the user's own clock from `timeZone`, so DST is handled. `quietStart` is inclusive and `quietEnd` is exclusive. A window like 22:00–07:00 runs past midnight. If start equals end, I treat it as no quiet hours.
3. **Daily cap → `daily_cap_reached`.** "Day" means the user's local calendar day, midnight to midnight in their zone. It is not UTC and not a rolling 24 hours. A `dailyCap` of 0 blocks everything.

If the call is allowed, it returns `{ allowed: true, reason: null }` and records the push. Blocked attempts are never recorded, so they don't use up the cap.

**State and settings.** Each gate keeps its own in-memory history per user and drops entries older than 72 hours. Settings are read fresh on every call. If a user's zone changes, today's count is recomputed in the new zone.

**What the test covers.** Quiet-window edges, a window past midnight, and a same-day window. It also covers the cap resetting at local midnight while it is still the same UTC day, and blocked attempts not counting. The rest: a DST spring-forward day, `dailyCap: 0`, invalid input, two gates being independent, and per-call settings changes.

**Not covered.** There is no minimum spacing between pushes, since you only asked for quiet hours and the cap. The Knock skill's timing guidance says to delay quiet-hour sends rather than drop them, and to batch sends over the cap. This gate only allows or blocks, so the agent has to decide whether to retry later or skip.
