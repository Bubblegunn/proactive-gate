`bot.mjs` is in the current folder and exports `decide`, `whyNotReceived` and `dryRun`. I checked it with one script in a single process, and the results were as expected.

**What the check covered**
- **Consent and zone:** a user without `consent: true` is blocked with `NO_CONSENT`. An invalid time zone is blocked with `INVALID_TIMEZONE`.
- **Quiet hours:** 23:00 New York time is blocked with `QUIET_HOURS`.
- **Daily cap:** four notifications sent at once for one user gave 3 delivered and 1 blocked, and the extra one got `DAILY_CAP`.
- **Next day:** a notification the next morning was delivered.
- **Repeated id:** sending the same notification id twice returns the same answer and counts once.
- **Support log:** `whyNotReceived` returns the entries in the order they were considered, with ISO times. The `text` gives the retry time as a local clock time with the zone name, for example "08:00 on 23 Oct (America/New_York)".
- **Dry run:** with `dailyCap: 2` over five events it gave `{ delivered: 2, blocked: 3 }`. With quiet hours 23:30 to 07:00 it delivered an event at 23:00 local time.

**Not checked:** I did not run several worker processes at once. The code uses a lock directory and atomic file writes, but only the one-process script above was run.

**Behavior you may want to know about**
- **Check order:** consent, then time zone, then quiet hours, then the cap.
- **Cap and retry time:** a blocked notification does not count toward the cap. The retry time for a cap block is the start of the next local day, moved to 08:00 if midnight falls inside quiet hours.
- **Window edges:** quiet hours include 22:00 and exclude 08:00.
- **Dry run:** it is pure in-memory replay and reads or writes no state. It processes events in time order, and repeated notification ids get the first answer.
- **State:** each decision is a file under `STATE_DIR`, with one lock per user. `STATE_DIR` is read on every call, and `decide` throws if it is not set.
- **No dependencies:** none were added, so there is no `package.json`.
- **File layout:** the gate kit's helper functions are appended to the end of `bot.mjs`.

I made no commit.
