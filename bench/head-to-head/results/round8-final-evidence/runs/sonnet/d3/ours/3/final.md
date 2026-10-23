`bot.mjs` is written. It exports `reserve({ userId, timeZone, channel, now })` as you specified.

**How it works**
- It keeps one counter per customer per local day in `STATE_DIR`. The day is the midnight-to-midnight date in the customer's `timeZone`, and all three channels share the one counter.
- The counter increment is atomic across processes, so two workers can't both take the last slot.
- Nothing is cached in memory. `STATE_DIR` is read on every call and created if missing, so restarts lose nothing.
- It never reads the system clock; it uses only `now`.
- The `rule` values it returns when `allowed` is false:
  - `daily-cap`: the customer already has 2 messages that local day.
  - `invalid-time-zone`: the zone name isn't a valid IANA zone. It is held, not guessed.
  - `invalid-channel`, `invalid-user` and `invalid-time`: the input was malformed.
- It reuses the helper functions from the proactive-gate skill's `gate-kit.mjs`, which I copied onto the end of the file.

**Checks I ran**
- Six separate Node processes, each making 3 simultaneous calls for the same customer (18 calls in all). Exactly 2 were allowed and the rest got `daily-cap`.
- A new process on the same day still got `daily-cap`. A call at 00:00 Tokyo time on the next day was allowed again.
- A call with a bad zone (`Mars/Base`) was held with `invalid-time-zone`.

**Not checked**
- The counter is not tied to the zone you pass. If the same customer shows up with two different zones, both calls land on the same date label (for example `2026-10-23`). That is fine if each customer has one zone. I did not test changing a customer's zone.
- I did not simulate a crash between `reserve` returning `allowed: true` and the send. If the send then fails, the slot stays used. You can give a slot back with `gkRefund` if you want that.

**Choices I made**
- The daily cap is 2.
- There is no message id in your signature, so a retry of the same message would count again. Add an id if you need retries to be safe.
- I did not add logging, because the `rule` you get back already tells you which rule held the message. If you want a log line per decision, say so.
