`bot.mjs` is written at `work/courier-g4-1/bot.mjs`, and all 15 checks pass. Nothing was sent. I did not commit it.

**What it does**

- **Shared state:** each lead has a history file under `STATE_DIR/leads/`, keyed by a hash of the userId. A per-lead lock directory serializes read-modify-write, so workers on the same lead can't race, and different leads don't block each other. `STATE_DIR` is created if missing.
- **Limits:**
  - `per_window_limit`: fewer than `maxPerWindow` counted sends in the last `windowHours`. The window slides, so any span of that length holds at most N messages.
  - `min_gap`: no counted send within `minGapMinutes` of `now`, checked on both sides so an out-of-order clock can't slip through.
- **What counts:** every allowed reservation that is not released. A reservation whose worker crashed still counts, because the message may have reached the lead. Blocked attempts don't count.
- **Release:** the reservation id starts with the lead's key, so any worker can find the right file without a global index. Releasing removes the entry. It returns `true` once, then `false` for repeats or unknown ids.
- **Failure:** bad input, corrupt state, or a lock wait over 10 s throws. Callers should treat a throw as "not sent".

**Verification**

The check script is in `/tmp/bot-check/check.mjs`, outside the work directory. It covers:
- the cap and both reason codes
- the sliding-window boundary
- per-call limits
- release, including release from another process
- a stale lock left by a dead worker
- 12 processes racing on one lead at the same instant, which yields exactly 3 allowed
- state surviving a restart
- corrupt state failing closed

Local Node is v24, not 22. I used only long-stable APIs, but I have not run it on Node 22.

**Known limits**

- Stale-lock breaking uses a 15 s age threshold. If a worker stalls past that while another breaks its lock, two sends could slip through. That needs a stall of several seconds inside a few-millisecond critical section, so I judged it unlikely.
- Writes are fsynced at the file level only. That covers worker restarts, not a machine crash mid-rename.
- Retention keeps records for the largest window or gap seen so far. A campaign that later uses a longer window will not see history that was already pruned under a shorter one.
