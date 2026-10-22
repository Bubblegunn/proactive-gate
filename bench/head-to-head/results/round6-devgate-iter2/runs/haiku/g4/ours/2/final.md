`bot.mjs` is written in the work directory and passes a 13-case self-check, including races between separate Node processes. Nothing was sent, and I did not commit.

**How it works**
- Each lead gets a directory under `STATE_DIR/users/<sha256(userId)>/`, with one JSON file per sent slot. Every call reads `STATE_DIR` fresh and creates it if missing.
- A `mkdir`-based lock per lead serializes reserve calls across processes. A lock older than 10 s is treated as left by a crashed worker. Writes go temp file then rename.
- `reservationId` is `<userHash>.<uuid>`, so any worker can release it without knowing the user.

**Choices I made**
- **What counts:** a slot counts from reserve until release. Released slots are deleted. In-flight sends count as sent, since an unknown outcome is the safe side for the recipient.
- **Window:** sliding. A slot sent at T counts in (now − window, now], so a lead is free again exactly `windowHours` after the message. Slots from a skewed clock ahead of `now` still count.
- **Gap:** measured in both directions (`|now − sent| < gap` is refused), so a worker with a slightly fast clock can't let two messages land close together. Exactly `minGapMinutes` is allowed.
- **Reason codes:** `window_limit_reached` and `min_gap_not_elapsed`. Window is checked first.
- **Release:** idempotent. Unknown, malformed, or already-released ids are no-ops.
- **Limits I set:** windowHours ≤ 720, slots pruned after 30 days, lock timeout 10 s. Invalid input throws a `TypeError`.

**Gaps to decide on**
- **No message id in the API,** so a caller that retries `reserve` after a timeout spends a second slot. The fix is a `messageId` field, which the request doesn't include. I did not add one.
- **No consent, opt-out, or quiet-hours checks.** The request doesn't mention any, so I didn't add them. If you need them, they belong in the caller or in a separate gate.

**Verification:** ran in a temp `STATE_DIR` on Node v24.13.0 (the target is 22+, not tested on 22). Checks covered a 10-way in-process race (3 allowed), an 8-process race (3 allowed), release from another process making the slot reusable, the 89/90-minute gap edge, the 24-hour window edge, and idempotent release. All passed, and no stale locks were left. The check script is in `/tmp/bot-check/`, outside the repo.
