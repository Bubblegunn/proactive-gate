`bot.mjs` is written and tested. It exports `reserve({ userId, timeZone, channel, now })` and returns `{ allowed, rule }`. When a message is held, `rule` is `"daily-cap"`; when allowed it is `""`.

**How it works**
- **Day:** the day is the calendar date of `now` in the customer's own time zone, so midnight to midnight local. `now` is the only time source; the code never reads the system clock.
- **Counting:** each allowed message creates one small file in `STATE_DIR/marketing-daily-cap/`, named for the user and local day plus a slot number (0 or 1). The file is created with the exclusive-create flag, which only one process can win for a given path.
- **Cap:** a call tries slot 0, then slot 1. If both already exist, it returns `{ allowed: false, rule: "daily-cap" }`. All channels share the same two slots.
- **No locks:** there is no lock and no read-then-write step. That means no stale lock after a crash, and no race between workers or between concurrent calls in one worker.
- **Restarts:** the count lives only in these files, so it survives restarts. Each file is flushed to disk before `reserve` returns.
- **Crash after reserve:** if a worker dies after `reserve` returned `allowed: true` but before it sent, that message still counts. The cap errs on the side of sending less.
- **Debugging:** each file holds a JSON line with the user, channel, time zone, local day and `now`. The log question you raised ("which message should have been held") can be answered from these files. Files are never deleted, so they pile up over time and old days can be cleaned up separately.
- **Bad input:** a bad `timeZone`, `channel`, `now` or a missing `STATE_DIR` makes `reserve` throw instead of guessing.

**What I tested** (Node 24 here, with `STATE_DIR` at a path that did not exist yet; I did not run it on Node 22):
- Six separate processes each made 5 concurrent calls for the same user, so 30 calls in total. Exactly 2 were allowed.
- A fresh process on the same day was held.
- For Asia/Tokyo, 14:59:59Z (23:59 local) was still held, and 15:00:00Z (the next local day) allowed 2 more.
- For America/Los_Angeles, 06:59Z and 07:00Z fell on different local days, and each day allowed 2.

If a customer's `timeZone` changes during a day, the two time zones count that day separately, so they could get up to 2 messages under each. I left that as is because the spec ties the day to the customer's time zone.
