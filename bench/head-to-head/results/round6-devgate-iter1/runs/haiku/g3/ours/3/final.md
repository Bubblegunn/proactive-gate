`bot.mjs` is written in the working directory and passes a self-check. I did not send anything.

**How it behaves**

- **Transactional** (receipts, password resets) is always allowed, even after an unsubscribe. CAN-SPAM covers transactional messages, and people expect those to keep arriving.
- **Marketing** (newsletters, the agent's "we miss you" emails) is blocked with `reason: "unsubscribed"` once the latest unsubscribe is not overtaken by a later resubscribe. A tie in `at` favors the unsubscribe.
- **Ordering**: the latest event is chosen by the provider's `at`, not by arrival order. A late, older unsubscribe does not undo a newer resubscribe.
- **Addresses**: header forms like `Name <<EMAIL>>` and `mailto:` are accepted. Case is ignored. For Gmail (including googlemail.com), dots and `+tag` are ignored. Other domains lose only the `+tag`. An address that cannot be parsed is blocked for marketing with `invalid_recipient`.
- **State**: each event is one JSON file under `STATE_DIR/optout/<sha256 of address>/`, written to a temp name and then renamed. Workers do not overwrite each other and no lock is needed. Nothing is deleted, so opt-outs survive restarts. `STATE_DIR` is read on every call. If it is unset, marketing checks throw, which fails closed.
- Recording throws on bad input, so the webhook handler can return an error and let the provider retry.

**Assumptions and gaps to check**

- The interface carries no consent field, so I did not block marketing for lack of opt-in. Your queue must only contain people who signed up.
- The agent's "we miss you" emails must be labeled `kind: "marketing"`. If they are labeled `transactional`, they bypass opt-out.
- `now` is accepted but not used, because each event carries its own provider time.
- I added no frequency caps or quiet hours, since the request did not ask for them.
- Gmail's two-day and CAN-SPAM's ten-business-day deadlines are met, because the opt-out is written before `recordUnsubscribe` returns.

**Self-check:** I ran these scenarios in a temp `STATE_DIR`, and all passed:
- a fresh address is allowed
- an unsubscribe blocks marketing and still allows transactional
- a later resubscribe re-allows marketing
- a late older unsubscribe does not revert it
- a Gmail alias is blocked
- a tie favors the unsubscribe
- an invalid address is blocked
- 40 concurrent resubscribes all land
- a bad date throws
- an unset `STATE_DIR` throws

`node --check` passes. I did not run the library path, because this task asked for a single self-contained file.
