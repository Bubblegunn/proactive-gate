`bot.mjs` is written, and an inline check on Node 24 passed. I wrote it by hand, with no dependencies and no library. It keeps history in memory only, as you said. Nothing is sent.

**Reason codes**

| Code | Meaning |
|---|---|
| `quiet_hours` | The user's local time is inside their quiet window. |
| `daily_cap_reached` | The user already has `dailyCap` pushes today. A cap of 0 blocks everything. |
| `invalid_time_zone` | `timeZone` is missing or not a real IANA zone. |
| `invalid_quiet_hours` | `quietStart` or `quietEnd` is not a valid HH:MM string. |
| `invalid_daily_cap` | `dailyCap` is not an integer of 0 or more. |
| `invalid_time` | `now` is not a valid Date. |
| `invalid_user` | `user` has no string `id`. |

**Behavior**
- **Local time:** quiet hours and "day" both use the user's own zone, never UTC. The "day" is the user's local calendar day, so a user in Los Angeles gets a fresh budget at local midnight.
- **Quiet window:** it includes the start minute and excludes the end minute. If the start is later than the end, it runs past midnight. DST is handled by the zone database. If start equals end, I treat that as no quiet hours.
- **Bad settings:** an invalid zone, time or cap is refused rather than guessed. For a "don't wake people" feature, a wrong guess is worse than a held push.
- **Order of checks:** quiet hours first, then the cap. Only allowed attempts count toward the cap. Refused ones don't.
- **Per-call settings:** zone, quiet hours and cap are read from each call. If a user's zone changes, past pushes are counted by their local day in the new zone.
- **Memory:** history older than 3 days is dropped.

**What the check covered:** a normal allowed push, both quiet-window edges including the overnight wrap, cap 3 then refusal, no counting of refused pushes, and a Los Angeles local day that differs from the UTC day. It also covered the Los Angeles DST change on 2026-11-01, invalid zone, HH:MM and cap, cap 0, and gates being independent of each other.

**Not checked:** the spring-forward DST gap, and many users or long runs.

**Not added:** a minimum gap between pushes. You didn't ask for one, and the user's `dailyCap` is the limit. If users still feel spammed with cap 3, a cooldown such as 2 hours would be the next lever. It would need its own code, for example `too_soon`.
