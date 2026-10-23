`bot.mjs` is in the current folder and it works in my checks. It has no dependencies, so `package.json` is unchanged. Nothing is actually sent.

I ran it through a scripted set of calls in two separate Node processes, to check that state survives a restart. Every case gave the result I expected, with these rules:

- **Stays quiet (`send: false`, short plain `reason`) when:**
  - the user is in a crisis;
  - focus mode is on;
  - the account is under 3 days old;
  - the finding has fewer than 5 data points or confidence below 0.6;
  - the same finding was delivered in the last 14 days, or the same candidate id was already delivered;
  - the last delivery was under 3 hours ago;
  - 2 messages were already delivered that local day, or 6 in the last 7 days;
  - the input is incomplete or malformed, including an invalid timezone, an invalid `now`, or `STATE_DIR` not set. It never throws.
- **Chooses surfaces when it sends:** `inApp` is always included. `push` is added only outside local quiet hours (22:00–07:59 in the user's timezone). It is also left out when the user dismissed more than 60% of earlier messages in that hour, once there are at least 5 samples.
- **State:** it writes one JSON file in `STATE_DIR`, creating the directory if needed. Only delivered messages are recorded, since those are what count as delivered. Writes go to a temp file and are then renamed into place, and calls within one process run one at a time.

Choices I made that you may want to change:

- Focus mode suppresses `inApp` as well as push. I read "do not disturb" as covering both.
- A message held back for any reason is dropped, not queued. The same finding can come again later.
- The thresholds are constants at the top of `bot.mjs`.
- Two separate processes sharing one `STATE_DIR` have no file lock. They could overwrite each other's record.
