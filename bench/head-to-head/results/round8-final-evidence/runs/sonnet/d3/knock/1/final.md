`bot.mjs` is written, and my test passed. Nothing was sent.

**How it works**
- Each customer gets a state file under `STATE_DIR/users/`. The file name is a hash of the `userId`, and it holds the times of that customer's recent allowed sends.
- Each customer also has a lock directory under `STATE_DIR/locks/`. A call takes the lock, counts today's sends, and decides.
- If the customer already has 2 sends today, it returns `{ allowed: false, rule: "daily-cap" }`. Otherwise it saves the new send, then returns `{ allowed: true, rule: "" }`. The save is written to disk and the lock is released only afterwards. That is why two workers can't both take the last slot, and why a restart doesn't lose the count.
- A "day" is the calendar date in the customer's `timeZone`, computed from the `now` you pass in. The system clock is never read. Sends from earlier calls are re-dated in the current `timeZone`, so a customer whose zone changes mid-day is still counted correctly.
- Calls inside one worker are queued per customer. Sends older than 48 hours are dropped from the file.
- A bad `userId`, `channel`, `now` or `timeZone`, a missing `STATE_DIR`, or a corrupt state file makes the call throw. The worker should treat a throw as "don't send", since the cap can't be checked.

**What I tested**
I ran the test in `/tmp/captest/`, outside your repo, using real separate processes:
- 8 processes making 5 simultaneous calls each for one customer: exactly 2 allowed, and every refusal had `rule: "daily-cap"`.
- Fresh processes started afterwards were still refused for the same day.
- The same Tokyo customer was allowed again at Tokyo midnight (15:00Z).
- A New York customer was checked on either side of local midnight: 2 allowed before it and 2 after.
- Different customers don't affect each other.

**Limitation:** a lock left behind by a crashed worker is broken after 15 seconds. That is safe as long as no call holds the lock longer than that, and a call normally holds it for a few milliseconds. A call that waits more than 60 seconds for a lock throws.
