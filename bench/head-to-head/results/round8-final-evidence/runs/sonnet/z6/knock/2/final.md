`<HOME>/…/knock-z6-2/bot.mjs` is written and exports `decide`, `whyNotReceived` and `dryRun`. I tested it and it passes. There are no dependencies, so `package.json` is unchanged.

**What I tested**
- **Single process:**
  - Cap: 3 deliveries go out and the 4th is blocked.
  - Quiet hours: 22:00 is blocked and exactly 08:00 is allowed, tested with Europe/Istanbul.
  - Consent: a user without consent is blocked.
  - `whyNotReceived`: `from` is inclusive and `to` is exclusive, and `availableAt` comes out as the next 08:00 local time.
  - `dryRun`: results are correct for the default, relaxed and strict policies, and it doesn't touch real state.
- **Concurrency and restart:** 6 separate processes made 30 attempts for one user on one day. Exactly 3 were delivered. A fresh process then read the same state back.
- **Not tested:** DST transitions are untested.

**How it works**
- **Rule order and codes:** consent is checked first, then quiet hours, then the daily cap. The codes are `NO_CONSENT`, `QUIET_HOURS` and `DAILY_CAP`. A missing or invalid timezone is blocked with `INVALID_TIMEZONE`.
- **State:** each user has one append-only file in `STATE_DIR`, with a lock so concurrent workers can't both pass the cap. A lock left by a crashed worker is cleared after 15 seconds.
- **`availableAt`:** it is the next 08:00 local time for quiet hours. For the daily cap it is the start of the next local day, pushed past quiet hours if needed. It is `null` for no consent, an invalid timezone, or a cap of 0.
- **`dryRun`:** it uses the same rule code as `decide`, keeps its counts in memory, and processes events in time order.

**Choices to confirm**
- If a notification that was already delivered is retried, `decide` returns `{ send: true }` again and doesn't count it twice. That way a worker retry can't use up the cap. A retry of a blocked notification is evaluated again and logged as a new entry.
- The daily cap counts the local calendar day in the user's timezone.
- In `dryRun`, a quiet-hours window with the same start and end means no quiet hours.
- `whyNotReceived` text is hardcoded to the production rules (22:00 to 08:00, cap of 3). `dryRun` takes whatever policy you pass it.
