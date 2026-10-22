`bot.mjs` is written at `work/knock-inv-g3-2/bot.mjs`. It passes my behavioral checks and nothing was sent. I loaded the `knock-notification-best-practices` skill and used its implementation rules (preference hierarchy, hard-failure handling, CAN-SPAM and opt-out expectations) to shape the design.

**How it works**
- **Shared state:** `STATE_DIR/suppression.jsonl`, append-only, one JSON record per line, written with `O_APPEND` and fsynced. Every worker appends to and reads the same file, so a restart loses nothing.
- **Out-of-order events:** each address keeps the latest `unsubscribe` time and the latest `resubscribe` time. Marketing is allowed only if the resubscribe is strictly later. A tie counts as opted out. A late-arriving old event cannot undo a newer one.
- **Scope of an opt-out:** `marketing` mail is blocked. `transactional` mail (receipts, password resets) is always allowed, since the person still expects those.
- **Identity:** addresses are normalized to the person behind them. The code lowercases, handles `Name <addr>` and `mailto:` header forms, maps `googlemail.com` to `gmail.com`, drops Gmail dots, and strips `+tag` aliases. Over-matching is deliberate, because a missed opt-out is the costlier error.
- **Reasons:** `marketing_unsubscribed`, `invalid_recipient`, `unknown_kind`. Bad recipients and unknown kinds are denied rather than thrown, so the queue can log and move on. A missing `STATE_DIR` throws, so nothing is sent blind.

**Checks run** (scratch harness in `/tmp`, removed afterward)
- Unsubscribe blocks marketing and leaves transactional alone.
- Alias and header variants of the same person are blocked.
- Out-of-order resubscribe and unsubscribe, ties, and late resubscribe behave as specified.
- A torn line from a crashed writer is skipped and does not corrupt the next record.
- A separate process sees writes from an earlier process.
- Eight concurrent processes × 50 records each: nothing lost.
- Invalid input throws or denies as described. `node --check` passes.

**Choices and limits you should check**
- `STATE_DIR` must be on a local filesystem. `O_APPEND` atomicity is not guaranteed on NFS.
- Stripping `+tag` on every domain is aggressive. It can suppress a different mailbox on non-Gmail providers. I chose that over risking a missed opt-out.
- The module has no consent record. Callers must only queue marketing to people who opted in. A purchase or login must not call `recordResubscribe`; only an explicit signup should.
- `now` is validated but not used. I did not add time-based rules, since none were specified.
- Addresses are stored in plaintext in the state file, since matching needs them. Restrict access to `STATE_DIR` accordingly.
- Not committed. The repo has no other code in this directory, so I did not add a test file to the deliverable.
