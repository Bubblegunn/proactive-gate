`bot.mjs` is written and passes my self-check. It exports `recordUnsubscribe`, `recordResubscribe` and `mayEmail`. Nothing was sent.

**Rules**
- **Transactional** emails (receipts, password resets) are always allowed. CAN-SPAM exempts them, and people still expect them after unsubscribing.
- **Marketing** emails, including the agent's "we miss you" mails, are refused with reason `unsubscribed` after an unsubscribe. A later deliberate resubscribe allows them again.
- **Unknown `kind`** values are treated as marketing, which is the stricter rule.
- **Invalid recipient** on a marketing message returns `invalid_recipient`.
- **Opt-outs take effect on the next call.** That is faster than the CAN-SPAM limit of 10 business days and Gmail/Yahoo's 2 days.

**Late and out-of-order events**
- For each address, the event with the latest `at` wins, so a late webhook can't undo a newer decision.
- If two events have the same `at`, the unsubscribe wins.

**Addresses**
- Addresses are lowercased and trimmed.
- Header forms like `"Ann" <<EMAIL>>` and `mailto:` are reduced to the plain address.
- I did not collapse Gmail dots or `+tags`, so `user+x@` is a separate address from `user@`.

**State**
- State lives in `STATE_DIR`, read on every call and created if missing. It is one file per address, so it survives restarts and is shared by all workers.
- Writes go to a temp file and are then renamed. A per-address lock directory covers the read-then-write, and a lock left by a dead worker is cleared after 10 seconds.
- If a state file can't be read, `mayEmail` throws instead of treating the address as not opted out.

**Checks I ran**
I ran these against a temporary `STATE_DIR`:
- A marketing email is allowed before any event.
- An unsubscribe with a messy address is matched.
- A transactional email is still allowed.
- A newer resubscribe re-allows marketing.
- A late, older unsubscribe is ignored.
- A newer unsubscribe blocks again.
- 20 concurrent conflicting writes complete without errors.
- A fresh process reads the saved state and refuses marketing to the unsubscribed address.

I did not test separate worker processes writing at the same time.

**Skipped:** I wrote the gate inline, as the proactive-gate skill's default says, instead of using its library or scaffold. The skill also asks for plain-sentence refusals, but I used snake_case codes because you specified them.
