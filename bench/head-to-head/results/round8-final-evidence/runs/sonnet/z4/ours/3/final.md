`bot.mjs` is written in the current folder. It has no dependencies, so there is no `package.json` change. It exports `decide` and `REASON_CODES`. I ran it against a fresh STATE_DIR and it gave the expected answers.

**What `decide` does**
- **Requested** ("it's ready"): always delivered. It does not count toward the nudge cap, and no new-user wait applies.
- **Reminder** (set by the user): always delivered, with no cap and no new-user wait.
- **Inferred** (suggestions): held in these cases:
  - the user is new, meaning the later of `createdAt` and `profileCreatedAt` is under 48 hours ago;
  - `dailyNudgeCap` is already used up for the user's local day;
  - the timezone is invalid;
  - the dates or the cap are unusable.
- **Redelivery:** each message id is claimed before it counts as sent. A second call with the same id returns `send:false` with `already_delivered`. A cap refusal gives the claim back.
- **State:** the code reads STATE_DIR on every call and creates the directory if needed. Claims and counters use atomic helpers (from the gate kit appended to `bot.mjs`), so several workers can share them and they survive a restart.

**Numbers I chose**
- New-user wait for inferred nudges: 48 hours.
- Cap: `config.dailyNudgeCap` per user per local day. I added no cap of my own.
- No quiet hours, because you didn't ask for any.

**Self-check**
My script covered these cases:
- A requested message is delivered, and a repeat of the same id is refused.
- With a cap of 2, the third inferred nudge is held.
- A reminder is delivered.
- A new user is held.
- A bad timezone is held.

Every refusal code it returned is in `REASON_CODES`.

I did not check two things:
- **Concurrency:** I only ran one process, so several workers racing on the same id or cap is untested.
- **Day boundary:** I did not check the cap resetting at the user's local midnight.

**Not enforced:**
- **Opt-in:** the interface carries no consent or opt-out field, so nothing is held for missing opt-in.
- **Opt-out:** I did not add STOP handling. The code never reads or writes an opt-out record, so an opt-out has to be handled before `decide` is called.

**Two judgment calls**
- If the app passes in a message id that was already delivered, it gets `send:false`, not the original `send:true`. I chose this so the same message is never sent twice.
- `REASON_CODES` also lists the codes returned when `send` is true (`requested_ready`, `reminder_due`, `nudge_allowed`), not only the refusals.
