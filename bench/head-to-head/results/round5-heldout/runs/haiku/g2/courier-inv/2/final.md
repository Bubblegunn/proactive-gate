Wrote `bot.mjs` in the work directory. All 13 behavior groups pass, run from a scratch directory outside the repo. Nothing is sent and nothing is committed.

**What the gate does**
- **Quiet hours:** Judged on the user's local clock in their IANA zone, so DST is handled. A window like 22:00–07:00 wraps midnight. The end is exclusive, so 07:00 is allowed. Blocked reason: `quiet_hours`.
- **Daily cap:** "Per day" means the user's local calendar day (midnight to midnight in their zone), not a rolling 24 hours and not UTC. A push at 23:50 and one at 07:10 the next morning are on different days. Blocked reason: `daily_cap_reached`.
- **Rule order:** Quiet hours are checked first, so a user in quiet hours at their cap gets `quiet_hours`.
- **Blocked attempts don't count** toward the cap. Only allowed pushes are recorded.
- **Settings are read per call**, so a changed `dailyCap` takes effect on the next attempt.
- **Invalid input throws** (bad zone, bad `HH:MM`, negative cap, bad `Date`) rather than silently allowing a push.
- **Memory** is bounded: each user keeps about 50 hours of timestamps, which covers any local day.

**Choices to check**
- `quietStart === quietEnd` means no quiet period. The spec didn't say, so I picked this.
- Restarts reset the cap, as you accepted.
- I did not add a minimum gap between pushes. Users complained about frequency as well as wake-ups, so a spacing rule may be worth adding. It's a one-function change.

**Guidance and Courier**
- The Courier skill's throttling guide says Courier's send limits and delivery windows only apply to sends routed through Courier. This gate is local, so it doesn't use them.
- I did not fetch Apple's or Google's current notification guidance. The principles I applied (relevance, respect for quiet and Focus/Do Not Disturb, user control, avoiding repetitive pushes) are from memory. Check them against the live pages before you cite them.
