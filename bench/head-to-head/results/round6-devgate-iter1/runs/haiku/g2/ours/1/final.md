I wrote `bot.mjs` in `work/ours-g2-1/`. It exports `createPushGate()`, and the returned `attempt(user, now)` is synchronous and sends nothing. All 20 inline checks pass on Node v24.13.0.

**Rules, in the order they are checked:**
1. **Invalid time zone** → `invalid_timezone`. The zone is checked with Intl. Unknown zones are held, never guessed.
2. **Quiet hours** → `quiet_hours`. Start is inclusive and end is exclusive, in the user's local time. If start is later than end, the window wraps past midnight, so 22:00–07:00 covers 22:00 through 06:59.
3. **Malformed quiet hours** → `invalid_quiet_hours`. Anything that is not a 24-hour `HH:MM` string is held.
4. **Invalid daily cap** → `invalid_daily_cap`. The cap must be an integer of 0 or more.
5. **Daily cap** → `daily_cap_reached`. "Per day" means the user's local calendar day, not a rolling 24 hours and not UTC. A push counts only when it is allowed.

Allowed pushes return `{ allowed: true, reason: null }`. Each `createPushGate()` call has its own history.

**Choices I made that you may want to change:**
- **Quiet hours come before the cap**, so a push at night is reported as `quiet_hours` even if the cap is also full.
- **Equal start and end** (for example 10:00–10:00) means no quiet period.
- **Missing or malformed quiet settings or cap are held, not treated as "off".** This follows the rule that a missing field is unknown. If some users have no quiet settings, every push to them will be refused.
- **No minimum gap between pushes.** You did not ask for one, so I did not add it. If the "too many" complaints continue after the cap, a spacing rule is the next thing to add.
- **No redelivery keys or opt-out or consent checks.** The input has no message id, consent field or STOP handling, so these are not implemented.
- **Memory is pruned** to today and yesterday per user, so it does not grow without bound.

I wrote the quiet-hours and daily-cap design from general principles about respecting quiet hours and limiting frequency. I did not check it against Apple's or Google's current notification guidelines, and I did not run any tests beyond the inline checks.
