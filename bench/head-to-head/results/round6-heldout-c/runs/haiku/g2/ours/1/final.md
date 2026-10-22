Wrote `bot.mjs` in the work directory. `decide(candidate, now)` is the only export. Self-check passed on 12 cases; nothing is sent.

**How it decides**
- **Transactional:** always `send: true`, with no quiet-hours or cap check. Only malformed input is refused.
- **Marketing:**
  1. Invalid or unknown IANA timezone → `invalid-timezone`. Malformed `quietStart`/`quietEnd` → `invalid-input`.
  2. Quiet window, in the customer's local time → `quiet-hours`. Start is inclusive, end exclusive. A start later than the end wraps past midnight.
  3. Marketing sends already counted today for this user → `daily-cap` once the count reaches 3. The day is the customer's local calendar day.
  4. Otherwise `send: true` and the count goes up by one.
- Refusals return `{ send: false, rule }` with the first rule that failed. Allowed sends return `rule: null`.

**Choices you should check**
- **Quiet hours do not apply to transactional pushes.** Your brief only exempted courier and security pushes from the cap. I read "must still hear about the courier" as covering quiet hours too. If the DND window should also hold transactional pushes, remove the early `return allow()` for transactional and let it fall through to the quiet check.
- **Only marketing sends count toward the cap.** Transactional sends are not counted.
- **State is in memory, per process.** A restart resets all counts, as you described. Two processes do not share counts. If that matters, the counts need a shared store.
- **I did not use the proactive-gate library.** The brief asked for a standalone module with in-memory state, so I wrote the gate by hand.

**Self-check results** (all as expected):
- 3 marketing sends allowed, the 4th refused with `daily-cap`.
- 00:30 local → `quiet-hours`. 22:00 local (start) → `quiet-hours`. 07:30 local (end) → allowed.
- Next local day → allowed again.
- Transactional during quiet hours, over the cap → allowed.
- Bad zone, bad time string, invalid date → refused with `invalid-timezone` or `invalid-input`.
