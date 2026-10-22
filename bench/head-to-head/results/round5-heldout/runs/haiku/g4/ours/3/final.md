`bot.mjs` is written at `work/ours-g4-3/bot.mjs`. It exports `reserve(request, now)` and `release(reservationId)`, and my self-check passes 17 of 17 checks. Nothing was sent.

**Behaviour choices**

- **Scope:** limits apply per lead (`userId`), across WhatsApp and SMS together, since the lead experiences both as messages from you.
- **What counts:** a reserved slot counts from the moment it is reserved, including while the send is still in flight. A refused request spends nothing, so retries don't push the window out. A released slot stops counting.
- **Window:** sliding. A send stops counting exactly `windowHours` after it was reserved.
- **Gap:** `minGapMinutes` is measured from the most recent counted send to this lead. Exactly at the gap is allowed.
- **Refusal codes:** `max_per_window_reached` and `min_gap_not_elapsed`, checked in that order.
- **Release:** the reservation id encodes the lead, so any process can release it. Releasing an unknown or already-released id returns `false` and changes nothing.

**State and concurrency**

- Everything lives under `STATE_DIR`, which is created if missing and read on every call.
- One JSON file per lead, written via temp file and rename.
- A `mkdir`-based lock serialises each read-modify-write across processes. A lock older than 10 s is treated as left by a crashed holder and removed.
- Entries older than 366 days are pruned, so `windowHours` must stay below that.

**Checks run** (from a separate temp directory)

- Gap refusal at 60 min, allowed at exactly 90 min.
- Window cap refusal, then reuse of a slot after `release`.
- Idempotent release and rejection of malformed ids.
- Sliding window expiry, per-call limits, and independence between leads.
- 12 concurrent child processes racing on one lead: exactly 3 allowed, the rest refused with the window reason.
- A release from a different process frees a slot.

**Limits of the check**

- The restart test is weak: it reuses the same process and state directory, so it does not prove a true restart. The cross-process tests do exercise file-based state.
- I did not check the Node version. The code uses only Node built-ins, but I have not confirmed a run on Node 22 specifically.
- Clocks: entries after the caller's `now` still count, so skew makes the limiter more conservative. A worker whose clock runs far ahead can block a lead until its clock catches up.
- The request had no consent, opt-out, or quiet-hours inputs, so I added none. If you need them, they belong in the caller or in a separate gate.
