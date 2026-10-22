I wrote `bot.mjs` in the working directory. `checkSms(user, now)` allows a text only between 08:00 and 21:00 in the patient's own time zone. It passes 29 checks, including DST changes, half-hour zones, and bad inputs, under three different machine time zones. Nothing was sent and nothing was committed.

**Behavior**
- **Allowed:** `{ allowed: true, reason, nextAllowedAt: null }` when local time is 08:00 to 20:59:59.999.
- **Held before 08:00 or at/after 21:00:** `nextAllowedAt` is the exact instant that local 08:00 occurs, computed from the zone's real offset and DST rules. The check at that instant returns allowed, and 1 ms earlier it does not.
- **Missing or unrecognised time zone:** held, with `nextAllowedAt: null`, because no clock time fixes it.
- **Phone not in `+` plus country code and digits:** held, with `nextAllowedAt: null`.
- **Invalid `now` or non-object `user`:** throws a `TypeError`, so a scheduler bug cannot quietly send.

**Decisions to confirm**
- **Window is 08:00–21:00 local for every patient,** including the non-US ones. I took this from the US telemarketing-hours norm as a conservative choice. Tell me if your counsel wants a different window or US-only rules.
- **No time zone means no text, ever, until the patient sets one.** The alternative is a fallback zone, which could send at the wrong hour. Your scheduler will keep seeing these as held, so it should not retry on a timer.
- **No weekend or holiday rule.** It is not in your spec and can be added.

**Not covered by this function**
- It has no state and no input for opt-outs or prior sends. If the complaint came from people who had opted out, or from too many texts per day, this gate does not stop that. Those checks have to live where the scheduler reads its data.

Tests are in `/tmp/checksms-test/check.mjs`, outside the repo. The repo has only the new `bot.mjs` as an untracked file.
