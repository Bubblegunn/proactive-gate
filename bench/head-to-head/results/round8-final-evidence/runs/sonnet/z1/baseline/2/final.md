`bot.mjs` is written and passed my checks. It needs no dependencies, so `package.json` is unchanged. The checks ran against a fresh `STATE_DIR`, including 12 simultaneous worker processes. Nothing was actually sent.

**Rules, applied in this order**
1. `flags.proactiveEnabled` must be `true`. Anything else, including a missing `flags`, blocks every type.
2. The user needs `consents.marketing === true`. A missing, empty or false value blocks the send. I treated the check-in as marketing-type consent, which was my assumption. If you classify it differently, change that one line.
3. Quiet hours use the user's local time. The phone's `deviceTimezone` wins over the saved `timezone`, so travelling users get the right hour. A missing, invalid or "UTC" placeholder zone counts as unknown. If both zones are unknown, nothing is sent. Sends are allowed from 09:00 to 20:00 local only.
4. `optOut` is permanent per type and saved to disk. It does not affect other types.
5. Dismissals back off. Each `recordDismissal` for a type makes that type wait 2^n days (2, 4, 8 and so on, up to 30). Other types are not affected.
6. Caps are counted per local calendar day. A type can send once a day, and all types together can send twice a day.
7. A `candidate.id` that was already delivered is never sent again, so retries cannot cause a double send.

If anything throws, such as a bad `STATE_DIR` or a corrupt state file, `decide` returns `send: false` instead of sending.

**State and concurrency**
- State is one file per user, named by a hash of the user ID, inside `STATE_DIR`. The directory is created if it is missing.
- A lock directory per user keeps the worker processes from overwriting each other. A lock left behind by a crashed process is cleared after 30 seconds.
- State is written to a temp file and then renamed, so a crash cannot leave a half-written file.

**What I tested**
- The kill switch, missing or false consent, and quiet hours in New York and Tokyo.
- Saved zone "UTC" with and without a device zone, and an invalid zone.
- Once-a-day and two-a-day caps, repeating a candidate ID, and dismissal backoff.
- Opt-out for one type leaving other types working.
- 12 simultaneous worker processes for one user: exactly one got `send: true`. A new process afterwards also got `false`, so the state survives a restart.

I did not test the stale-lock cleanup, because I could not simulate a crashed process.

The test script is `/tmp/bt/t.mjs`, outside the project folder.

I have not committed anything.
