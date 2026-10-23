`bot.mjs` is written and tested. In every test, no customer got more than 2 messages per local day. Nothing was sent.

**How it works**
- Each customer and local day has one append-only log file under `STATE_DIR/users/<sha256 of userId>/<YYYY-MM-DD>.log`. The day is worked out from `now` in the customer's `timeZone`, so DST and midnight are handled by `Intl`.
- A call appends one record, then reads the file. The first 2 records in the file are the allowed ones. The call is allowed only if its own record is among them.
- All processes see the same file order, so exactly 2 calls win however they interleave. There are no locks, so a crashed worker can't leave one stuck.
- Once a day already has 2 records, later calls return `{ allowed: false, rule: "daily-cap" }` without writing anything.
- State is on disk, so a restart loses nothing. `STATE_DIR` is created if missing.
- Invalid input (unknown channel, bad time zone, invalid `Date`, `STATE_DIR` unset) throws rather than letting a message through.
- Every record keeps the time, time zone and channel, so you can check the logs to see which message took which slot. The `rule` value is `"daily-cap"`.

**What I tested** (separate processes, one user, `STATE_DIR` not created beforehand)
- 8 processes making 5 simultaneous calls each: exactly 2 allowed.
- New processes later the same Tokyo day: 0 allowed.
- After Tokyo midnight, 4 processes making 3 calls each: exactly 2 allowed.
- A different user, and the same instant in Los Angeles versus Tokyo, each counted separately.
- A simple sequential run gave allow, allow, deny.

**Things to know**
- The slot is taken before the send. If a worker crashes between `reserve` and the send, that slot is lost for the day. This keeps the cap from being exceeded.
- Log files are never deleted, so you get one small file per user per active day. Add a cleanup job for old date files if that matters.
- If a customer's time zone changes mid-day, records with the same date string count together.
- I didn't call any Courier API. Courier's own frequency caps (`throttling.md`) are a separate option, but they don't give the per-customer, per-local-day count you asked for.
