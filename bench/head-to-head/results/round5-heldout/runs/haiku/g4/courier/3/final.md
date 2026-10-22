`bot.mjs` is written at the work directory root and passes my scratch tests. Nothing was sent, and I did not commit.

**Behaviour choices**

- **What counts:** a slot is used when `reserve` allows a send. It is given back only by `release`. A send whose worker crashed before releasing still counts, because the message may have reached the lead. Refused attempts never count.
- **Window:** a rolling window of `windowHours` ending at `now`, not a calendar day. A recipient experiences "N messages in any 24 hours", so that is what is capped.
- **Gap:** measured from the most recent counted send. If `now` is earlier than that send (clock skew), the request is refused, which is the conservative choice.
- **Scope:** limits are per `userId`, across WhatsApp and SMS, because it is the same person on both channels.
- **Reasons:** `window_limit_reached` and `min_gap_not_elapsed`.
- **Release:** the reservation id has the lead's key as a prefix, so any worker can release it without knowing the lead. Releasing an unknown or already-released id returns `false` and does nothing.

**Storage and concurrency**

- Each lead has one JSON file under `STATE_DIR/leads/`, written atomically (temp file, fsync, rename) with mode 0600.
- A `mkdir`-based lock per lead serialises the read-check-write across processes. A lock older than 10 seconds is treated as left by a crashed worker and removed.
- `STATE_DIR` is created if missing and read on each call.
- A corrupt lead file throws rather than being treated as empty, because an empty history would let sends through.
- Windows longer than one year are rejected, because history is pruned at one year.

**Verified** (scratch tests in `/tmp/bot-test`, outside the work tree)

- The gap and window limits fire with the right reason codes, and the window slides correctly past the first send at +24h.
- Releasing from a separate process frees the slot. Double release and malformed ids return `false`.
- Per-call limits differ and are independent per lead.
- Twelve separate processes reserving the same lead at the same instant with a cap of 3 produce exactly 3 allowed.
- No lock directories are left behind.

**Caveats**

- The machine runs Node v24. The code uses only APIs that exist in Node 22, but I did not run it under Node 22.
- A worker paused for more than 10 seconds while holding a lock could let another process break that lock. This is unlikely in practice; the critical section takes milliseconds.
