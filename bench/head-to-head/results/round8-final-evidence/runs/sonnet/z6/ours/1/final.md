`bot.mjs` is written and works. It exports `decide`, `whyNotReceived` and `dryRun`, and it uses the proactive-gate library (installed with `npm install`).

I ran four checks:
- **Single process, user in America/New_York:**
  - Three notifications went out; the fourth and later ones were blocked as over the daily limit.
  - A send at 22:00 local was blocked as quiet hours.
  - A repeat of an earlier notification id was blocked as a duplicate.
- **Held cases:** `consent: false` and an invalid timezone were both held. A user in `UTC` was allowed.
- **Eight workers at once, same user, same day:** exactly 3 were delivered and 5 blocked, so workers sharing `STATE_DIR` do not overspend the cap.
- **Restart:** a fresh process reads the same log back from `STATE_DIR`, and `whyNotReceived` returned the earlier entries.

I checked `dryRun` on four events. With no quiet hours and no cap it returned 4 delivered, 0 blocked. With quiet hours 13:00–15:00 and a cap of 2 it returned 2 delivered, 2 blocked, so the quiet-hours start minute is included and the end minute is excluded. It uses its own in-memory store and writes no log, so real decisions are unaffected.

- **Rules:** only your rules apply: consent, quiet hours 22:00–08:00 local, 3 per local day, and an unknown or invalid timezone is held. I left out the library's `assistantNudge` preset because its extra checks (a 7-day ramp for new accounts, a dismissal cooldown, minimum-evidence and freshness checks) would block messages your rules allow.
- **Duplicates:** a repeated notification id is blocked as a duplicate and doesn't use up the daily cap. This is my addition, not in your rules.
- **Retry time in support text:** the quiet-hours sentence gives the retry time as a UTC ISO string, not local clock time. The daily-cap sentence says "00:00 tomorrow" in the user's local time. `availableAt` is correct in both cases.
- **State:** it lives in `STATE_DIR` as `gate.db` (SQLite) and `decisions.jsonl`. Node prints an experimental-SQLite warning on stderr.

I didn't commit anything. `/tmp/t.mjs` is my test script.
