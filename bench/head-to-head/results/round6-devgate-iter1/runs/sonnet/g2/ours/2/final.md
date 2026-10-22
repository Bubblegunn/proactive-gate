`bot.mjs` is written and works. It's in `<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round6-dev1-sonnet/work/ours-g2-2/`. I checked it with one inline Node script and nothing was sent.

The rules run in this order. The first one that fails stops the push and gives its code.

| Code | Meaning |
|---|---|
| `invalid_time` | `now` is not a valid Date. |
| `invalid_user` | `user` is missing or `user.id` is not a non-empty string. |
| `invalid_settings` | `quietStart` or `quietEnd` is not a valid `HH:MM`, or `dailyCap` is not an integer of 0 or more. |
| `invalid_time_zone` | `timeZone` is not a valid IANA zone. |
| `quiet_hours` | The user's local time is inside their quiet window. |
| `daily_cap_reached` | The user already has `dailyCap` allowed pushes today. |

- **Quiet window:** it includes the start minute and excludes the end minute, so with 22:00–07:00, 22:00 is blocked and 07:00 is allowed. It wraps past midnight when start is later than end.
- **"Per day":** it is the user's own calendar day in their zone, not 24 hours and not UTC. The count resets at their local midnight, including across DST.
- **Counting:** only allowed calls count toward the cap. Blocked calls spend nothing.
- **Bad input:** an unknown or invalid zone or setting is refused, never guessed.
- **History:** it is one in-memory `Map` per gate, with one counter per user. Each `createPushGate()` call is independent, and each call uses the settings passed in that call.

The inline script used the Tokyo user from your example and a New York user. It confirmed:
- An allowed push at noon JST.
- Blocked at 22:00 and at 06:59, allowed at 07:00.
- A fourth push in one local day is refused.
- The count resets on the next local day.
- A bad zone and a bad `HH:MM` are refused.
- A second gate has its own history.

Things I decided, and one gap:
- **Equal start and end:** `quietStart` equal to `quietEnd` means no quiet window. A zero-length window seemed more likely than "quiet all day". Say if you want it the other way.
- **Not enforced:** I added no minimum spacing between pushes, because you didn't ask for one. The daily cap and quiet hours are the only limits.
- **Not checked:** the script did not test a DST transition day, so that part is untested.
- **Unrelated rules:** I didn't add the proactive-gate skill's consent and opt-out rules, because you gave no such fields.
- **Overridden by your spec:** your requests for snake_case codes and in-memory history replace the skill's defaults of plain-sentence refusals and shared on-disk state.
