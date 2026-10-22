`bot.mjs` is written and all 16 tests pass (`node --test bot.test.mjs`, Node v24.13.0 here; the target is Node 22). Nothing was sent. The Courier skill didn't change the design: this is a standalone gate in front of the queue, so no Courier API calls are involved.

**Files** (in `work/courier-inv-g3-1/`)
- `bot.mjs`: the three exports, no dependencies.
- `bot.test.mjs`: the test suite.

**How it works**
- **Storage:** one small JSON file per event under `$STATE_DIR/suppression/<sha256 of the address>/`. Files are written to a temp name and renamed into place, so other workers never read a half-written event. Nothing is held in memory, so restarts lose nothing. `STATE_DIR` is read on each call and the directories are created on demand.
- **Ordering:** for each person, the event with the latest `at` wins. A tie goes to unsubscribe. Arrival order doesn't matter, so a late old re-subscribe can't undo a newer opt-out, and a late old opt-out can't undo a newer re-subscribe.
- **Addresses:** the input is normalized to one canonical address per person. Display names and `<...>` header forms are stripped, the value is lowercased, `+tag` is removed on every domain, Gmail dots are removed, and `googlemail.com` maps to `gmail.com`. This is deliberately conservative: it may suppress an address that is technically a different mailbox, but it won't mail someone who opted out under another spelling.
- **Duplicates:** the file name depends only on the event content, so a replayed webhook overwrites the file with identical bytes.
- **Rules in `mayEmail`:**
  - Marketing is blocked (`unsubscribed`) once the latest event is an unsubscribe. The block applies immediately, with no grace period.
  - Transactional mail (receipts, password resets) is never blocked by an opt-out. CAN-SPAM exempts it.
  - Fail closed: if the store can't be read, marketing is refused (`suppression_check_failed`). Transactional still goes out.
  - Bad input is refused, never allowed: `invalid_recipient`, `invalid_message`, `unknown_kind`.

**Limits to know about**
- **No consent data.** The gate enforces opt-outs and re-subscribes only. It can't check that a person ever opted in, which Gmail and Yahoo expect for bulk mail. A "we miss you" email to someone who never signed up will pass.
- **Agent emails aren't distinguishable.** `kind` is only `marketing` or `transactional`. Agent-drafted win-backs go through the same `marketing` path as the newsletter. If you want them held to a stricter rule, the caller needs a separate kind.
- **`now` is unused.** The decision depends only on event timestamps, so `now` is accepted for the API but has no effect.
- **Spam complaints aren't recorded.** The spec only gives unsubscribe and re-subscribe. A complaint-based block would need its own input.
- **Caller must retry failed writes.** `recordUnsubscribe` throws if the disk write fails. The webhook handler has to retry, or the opt-out is lost.

I didn't commit anything, since you didn't ask for a commit.
