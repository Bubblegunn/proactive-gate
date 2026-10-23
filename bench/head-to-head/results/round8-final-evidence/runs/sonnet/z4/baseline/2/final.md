`<HOME>/Desktop/Open-Source/projelerim/proactive-gate/bench/head-to-head/results/round8-final/z-sonnet/work/baseline-z4-2/bot.mjs` now exports `decide` and `REASON_CODES`. It has no dependencies, so `package.json` is unchanged.

I ran it against a temporary `STATE_DIR` and the results matched what I intended. Nothing is actually sent.

**Rules, in order**
1. **Repeats:** a candidate id that was already delivered returns `already_delivered`, so a retry never sends twice.
2. **Requested and reminder:** these always send, at any hour. They don't count toward the cap and aren't held back for new users.
3. **Anything else (inferred, or an origin I don't recognise):** each of these checks can hold it back:
   - **New user:** nothing is sent until 24 hours after the later of `createdAt` and `profileCreatedAt`. Unparseable dates return `suggestions_unavailable`.
   - **Quiet hours:** nothing is sent from 21:00 to 08:00 in the user's timezone. An invalid timezone falls back to UTC.
   - **Daily cap:** at most `config.dailyNudgeCap` per user per local day. A missing or invalid cap is treated as 0.

**Reason codes:** `delivered_requested`, `delivered_reminder`, `delivered_suggestion`, `already_delivered`, `new_user_grace_period`, `quiet_hours`, `daily_suggestion_limit_reached`, `suggestions_unavailable`. None says "error".

**State:** it is stored per user as a JSON file in `STATE_DIR`, which is created if missing and survives restarts. Writes go through a temporary file and a rename, under a per-user lock directory. A lock older than 10 seconds is treated as stale and removed. Old data is pruned.

**If `STATE_DIR` is unusable:** requested and reminder notifications still send, and inferred ones are withheld.

**Checks I ran**
- **Single run, cap 2:**
  - A requested and a reminder notification both sent at 23:00 local.
  - A duplicate id was blocked.
  - Inferred was blocked at 23:00 and sent at noon until the cap, then blocked.
  - A new user's inferred notification was blocked, but their requested one sent.
- **Concurrency:** 20 parallel inferred calls with cap 2 sent exactly 2. 12 separate Node processes with cap 3 sent exactly 3.

**Assumptions:** the 24-hour grace period and the 21:00–08:00 quiet hours are my own choices, not from your spec. They are constants at the top of the file if you want different values.
