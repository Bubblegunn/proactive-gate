`bot.mjs` is written and passes my checks. It exports `reserve(request, now)` and `release(reservationId)`, both async.

**How it works**
- State lives in `STATE_DIR`, with one JSON file per lead. `STATE_DIR` is read on every call, and the directory is created if it doesn't exist.
- An `mkdir` lock per lead serializes workers, and writes go to a temp file and then rename. A lock older than 10 seconds is treated as stale and removed.
- The reservation id contains the encoded `userId`, so any worker can release it with no other information.

**Behaviour choices**
- **Sliding window:** a slot counts for `windowHours` after its reservation time, so a lead never gets more than N messages in any rolling window. A slot exactly `windowHours` old no longer counts.
- **Minimum gap:** measured from the most recent kept reservation.
- **Released slots:** they are deleted, so they count toward neither the window nor the gap.
- **Reason codes:** `max_per_window`, `min_gap` and `invalid_request`. If both limits block, the code names the one that clears last, since waiting out the other wouldn't help.
- **Clock skew:** the gap check uses the absolute time difference, so workers whose clocks differ slightly can't slip a message in just before another.
- **Cleanup:** slots older than 45 days are dropped.
- **Release edge cases:** releasing an unknown or already-released id returns `false` and does nothing.

**What I checked** (with limits 3 per 24h and a 90-minute gap)
- The first send is allowed.
- A send 60 minutes later is refused with `min_gap`.
- Sends 90 and 200 minutes in are allowed, and a fourth is refused with `max_per_window`.
- Releasing a slot lets a new send through, and a second release of the same id returns `false`.
- A send more than 24 hours after the first is allowed.
- With 12 separate Node processes reserving the same lead at once, exactly 3 were allowed.

I didn't test a worker crashing while it holds the lock (the stale-lock removal), a restart, or any send path, since nothing is sent.

**Rules from the skill:** I read the proactive-gate skill and wrote the gate inline, as it prescribes. Most of its rules (consent, quiet hours, opt-out, time zones) don't apply because your request defines only a send-count limiter. Opt-out and time-zone rules weren't added, and the gate never reads the message body, so no body check is added; "not enforced: body checks" applies.

**Gap:** `reserve` takes no message id, so a retried call for the same message spends a second slot. If your callers can retry, add a message id to the request and I'll make `reserve` return the same slot for the same id.
