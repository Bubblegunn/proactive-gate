I wrote `bot.mjs` in the working directory. It exports `createPushGate()`, and all checks pass. Nothing is sent.

The Courier skill didn't change the code much. This gate makes no Courier calls, so it's plain JavaScript. The skill's Universal Rules didn't apply.

**Rules, checked in order (first hit wins):**
1. **`quiet_hours`**: the user's local time falls in their quiet period. Start is inclusive and end is exclusive, so 07:00 is already allowed. A window that crosses midnight, like 22:00–07:00, wraps correctly.
2. **`daily_cap_reached`**: the user already got `dailyCap` pushes on their local calendar day.

**Choices I made:**
- **"Day" is the user's calendar day in their own IANA zone**, not a rolling 24 hours. A push at 23:30 Tokyo and one at 00:10 Tokyo count toward different days.
- **Quiet is checked before the cap.** A blocked push doesn't use up a slot.
- **Only allowed pushes are recorded.** History is pruned to 48 hours, which is enough to cover any local day, so memory stays bounded.
- **Bad input throws a `TypeError`** (invalid zone, malformed HH:MM, bad `dailyCap`, non-Date `now`). I chose this over returning a silent `false`, so misconfiguration shows up in logs. If the agent loop shouldn't see exceptions, tell me and I'll change it to fail closed with its own reason code.
- **Quiet hours are optional.** If both bounds are missing, there is no quiet period. If `quietStart` equals `quietEnd`, the window is empty.
- **I did not add a minimum gap between pushes.** That would be a third rule. The complaints were about nighttime wake-ups and too many per day, and the two rules above target those. A spacing rule is easy to add if you want it.

**Verification:** I ran a scratch test suite in `/tmp/push-gate-check/` (outside the repo) covering these cases:
- quiet boundaries and midnight wrap
- quiet blocks not consuming the cap
- the local-midnight reset
- zero cap
- per-user isolation and per-call settings
- independent gates
- a New York DST night
- each invalid input throwing
- the input object not being mutated

The sandbox runs Node v24.13, not 22. The code uses only standard features (`Intl` with `hourCycle`, `formatToParts`), which Node 22 supports, but I haven't run it on Node 22 itself.

**Not verified:** I did not check Apple's or Google's exact notification guidelines. I had no web lookup in this session. The rules follow the general principles (respect quiet settings, limit frequency, don't interrupt at night). If you need them cited, I can look up the current text.
