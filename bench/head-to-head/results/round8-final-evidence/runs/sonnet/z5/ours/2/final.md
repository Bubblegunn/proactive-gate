`bot.mjs` is written and exports `decide({ user, candidate, context, now })`. I ran it from a script against a fresh `STATE_DIR` and it behaved as expected. I didn't run the scaffold's own test file, and I deleted it. Nothing is actually sent.

**How it works**
- It uses the `proactive-gate` library already in `package.json` (the `assistantNudge` preset plus a freshness check). I installed it and adapted the scaffold. `bot.mjs` reads `proactive-gate.policy.json`, so keep both files.
- State goes in a SQLite database under `STATE_DIR`, read on every call. A second run in a new process saw the earlier decisions.
- A send returns `{ send: true, surfaces: ["push", "inApp"], reason: null }`. A refusal returns `send: false`, empty `surfaces` and a plain-sentence `reason`.

**What I checked**
- A normal insight (12 data points, confidence 0.9, 13:00 local) is sent to both surfaces.
- The same insight key again the same day is held, even under a new candidate id.
- An insight with only 1 data point is held as too little evidence.
- Focus mode is held.
- Crisis is held. I replaced the library's wording because it showed a meaningless retry time.
- 01:00 local is held for quiet hours, with a retry time of 08:00 local.

**Numbers I chose**
- Daily cap: 3 messages per local day, the preset default.
- Quiet hours: 22:00 to 08:00 in the user's local time.
- Evidence threshold: at least 5 data points and confidence of at least 0.5, from the preset's evidence check.
- Same insight key: at most once per local day.
- Freshness: candidates older than 24 hours are refused (this check only applies if the candidate carries a created-at time, which the app doesn't give).

**Not enforced:** opt-in consent. The app gives no consent field and no way to record an opt-in, so a missing opt-in holds nothing. Only an explicit `user.consent === false` blocks. The library's `optOut()` function is not exported from `bot.mjs`, so nothing can record an opt-out yet.

**Not checked**
- Repeated dismissals silencing a message type.
- The hour-of-day check that uses `hourStats`.
- The new-account (`accountAgeDays`) restriction.

I didn't build tests for these. I also never set `STATE_DIR` to a directory that doesn't exist yet or is read-only.
