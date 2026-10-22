`bot.mjs` is written at `work/ours-g3-3/bot.mjs`. It exports `recordUnsubscribe`, `recordResubscribe` and `mayEmail`, uses only Node built-ins, and nothing is sent. The self-check passed against a temp `STATE_DIR`.

**How it works**
- Each opt-out or opt-in event is its own file under `STATE_DIR/email-events/<hash of address>/`. It is written to a temp name and renamed into place, so workers never edit the same file and readers never see a partial event. Each call reads the directory fresh, so every worker and restart sees the same state.
- The newest event by `at` decides the state. An unsubscribe at the same time as a resubscribe wins.
- A late resubscribe that is older than the unsubscribe does not lift it.
- `mayEmail`:
  - Transactional mail is always allowed, including after an unsubscribe.
  - Marketing mail is blocked with `unsubscribed` after an unsubscribe.
  - An unparseable `to` gives `unknown_recipient`. A kind other than marketing or transactional gives `unknown_kind`. An unreadable state gives `state_unavailable`. All three fail closed.

**Choices I made that you should check**
- Addresses are normalised: display names and `mailto:` are removed, case is folded, and `+tag` is stripped for every domain. For gmail/googlemail, dots are removed and `googlemail.com` maps to `gmail.com`. Stripping `+tag` on other domains is an assumption.
- `reason` is a snake_case code, as your spec asks. I did not turn it into a sentence.
- There is no quiet-hours or time-zone check. The interface gives no zone, and you did not ask for one, so I did not add it.
- `now` is accepted but not used.

**Open risk**
The AI-drafted "we miss you" emails and the newsletters both arrive as `kind: "marketing"`, and the interface has no consent field. The gate therefore allows them unless the person has unsubscribed. If you want win-back emails held until an explicit opt-in is recorded, the message needs a consent or source field. I did not invent one.

**Self-check results**
- Before any opt-out: allowed.
- After an unsubscribe: marketing blocked, transactional allowed, `+tag` and gmail-dot variants blocked.
- A late older resubscribe is ignored; a newer one lifts the block.
- Another person is unaffected.
- 20 concurrent unsubscribe writes for one address: still blocked afterwards.
- A malformed `to`, an unknown kind, and a malformed email given to `recordUnsubscribe` (which throws) all behave as stated.

I did not test a process restart or a real multi-process race. The 20 parallel writes ran in one process.
