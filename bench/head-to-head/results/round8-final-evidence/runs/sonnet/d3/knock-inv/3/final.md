`bot.mjs` is written and passes my checks. I'm only summarizing now; nothing else is running.

**How it works**
- Each reserved message is one file in `STATE_DIR`. The name is `mkt-<sha256(userId)>-<local day>-<slot>.json` with slot 1 or 2. The code creates the file with the `wx` flag, which is atomic across processes.
- A call tries slot 1, then slot 2. If both already exist, it returns `{ allowed: false, rule: "daily-cap" }`. If it creates a slot, it returns `{ allowed: true, rule: "" }`.
- There is no lock file, so a crashed or restarted worker can't leave a stale lock. A slot file that exists counts as sent, even if the worker died right after creating it.
- The local day comes from `Intl.DateTimeFormat` in the customer's time zone, using only the `now` you pass in. The count is shared by sms, email and push.
- Each slot file records the channel and time, so you can see in `STATE_DIR` which messages used the two slots.
- It fails closed. A bad `userId`, `channel`, `now` or time zone, or a missing `STATE_DIR`, returns `allowed: false` with `invalid-user`, `invalid-channel`, `invalid-time`, `invalid-time-zone` or `no-state-dir`. The code creates `STATE_DIR` if it's missing. A file-system error is thrown, so the worker should treat a throw as "don't send".

**What I checked** (`/tmp/botcheck/check.mjs`)
- **Day boundary:** In Tokyo, 23:59:59 local is held and 00:00 local is allowed again. In New York, the midnight rollover follows EDT.
- **Concurrency:** 8 separate processes, each making 10 simultaneous calls for one user, allowed exactly 2 messages in total.
- **Restart:** a new process run afterwards allowed 0 more.
- **Invalid input:** a bad date and a bad time zone return `invalid-time` and `invalid-time-zone`.

Nothing was sent.

Two limits to know about:
- If a customer's stored time zone changes mid-day, the new zone starts a fresh count for its local day.
- Old slot files are never deleted. You may want a cleanup job for files older than a few days.
