I wrote `bot.mjs` in the work directory. It runs with no dependencies and sends nothing. I tested it with a scratch script outside the repo and all checks passed.

**How it stores state:** each person gets one append-only JSONL file under `STATE_DIR/suppression/`, named by a hash of their canonical address. Workers only append and fsync, so there are no locks, a restart loses nothing, and every worker reads the same history. A torn write from a crash is skipped on read and does not corrupt the next event.

**Rules:**
- **Unsubscribe** stops `marketing` mail to that person. `transactional` mail (receipts, password resets) is still allowed.
- **Resubscribe** re-enables marketing, but only if it is later than the latest unsubscribe.
- **Out-of-order events:** the event with the latest `at` decides. A late, older unsubscribe cannot undo a newer resubscribe. On an exact timestamp tie, unsubscribe wins.
- **Same person, different address:** the address is lowercased, header wrapping like `"Name" <addr>` is stripped, and `+tag` is dropped for every domain. For Gmail and googlemail.com, dots are also dropped. So `<EMAIL>` and `<EMAIL>` share one opt-out.
- **Failures:** marketing mail fails closed on any ledger read error (`suppression_state_unavailable`). A missing `STATE_DIR` throws instead of writing somewhere else.
- **Reason codes:** `unsubscribed`, `invalid_recipient`, `unknown_kind`, `suppression_state_unavailable`.

**Tests run:**
- All rules above, including the out-of-order and tie cases.
- A restarted module instance still sees the state.
- 8 concurrent processes wrote 480 events, and all 480 were present afterward.

**Choices and limits to check:**
- `now` is validated but does not change the decision. Provider clocks can run ahead of ours, so an unsubscribe stamped slightly after `now` still counts.
- Stripping `+tag` on every domain is deliberately aggressive. It may suppress a different mailbox on a non-Gmail domain that uses plus-addressing for separate people. I chose to over-suppress rather than risk emailing someone who opted out.
- The code has no list-membership data, because there is no "subscribed" event. It cannot block marketing to someone who never signed up. Your queue has to make sure only list members get marketing.
- The `kind` field decides what is blocked. An agent-drafted "we miss you" email must be labelled `marketing`, or it will pass the check.
- Ledger files keep plaintext addresses for the audit trail. Restrict `STATE_DIR` permissions accordingly.
- Locally I ran Node 24. The code uses only APIs that exist in Node 22, but I did not run it on Node 22 itself.
- I did not commit anything, because you did not ask for a commit.
