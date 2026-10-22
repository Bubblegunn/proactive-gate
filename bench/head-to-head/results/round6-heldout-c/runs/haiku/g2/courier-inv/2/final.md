`bot.mjs` is written and all 13 tests pass. Nothing was sent.

**Courier:** the Courier SDK and API are not used. The jobs send through their own push provider, and this module only decides whether a push may go. The `courier:courier` skill covers Courier's send API, which doesn't apply here.

**Files** (in `work/courier-inv-g2-2/`):
- `bot.mjs`: exports `decide(candidate, now)`, no dependencies.
- `bot.test.mjs`: `node --test` suite.

**Behavior:**
- **Transactional** always returns `{ send: true, rule: null }`. It skips quiet hours and the cap, and it is not counted.
- **Marketing** is checked in this order:
  1. `quiet-hours`: the customer's local time is inside the window. Start is inclusive, end is exclusive, and windows crossing midnight work.
  2. `daily-cap`: the customer already has 3 sends today in their own time zone.
  3. Otherwise it sends and counts the send.
- Blocked pushes are not counted, so a held push doesn't use up the day's allowance.
- Local day and time come from `Intl.DateTimeFormat` with the customer's IANA zone, so DST is handled. The server clock is never used for customer time.

**Choices to confirm:**
- **Quiet hours apply to marketing only.** The brief says a courier-waiting customer must still hear about the courier, so I let transactional through quiet hours too. If quiet hours should also hold transactional pushes, change the transactional branch in `decide`.
- **Quiet hours are checked before the cap.** When both apply, the rule is `quiet-hours`.
- **Bad input throws** (unknown time zone, malformed `HH:MM`, unknown category, invalid `Date`, empty `userId`) rather than returning a silent send or block. Callers must handle the exception.
- **`quietStart === quietEnd`** means no quiet window.

**Verification:** the suite covers quiet-window edges, a window crossing midnight, a Tokyo-versus-New-York time-zone check, cap reset at the customer's local midnight, per-customer isolation, and invalid input. The sandbox has Node v24.13.0; I didn't run it on Node 22. The code only uses features Node 22 has (`Intl` `formatToParts` with `hourCycle`, and `node:test`).

**Not done:** nothing is committed. The state is process-local, so a restart resets all caps, as the brief allows.
