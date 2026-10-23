`bot.mjs` is written, and my checks pass. The test file's on-disk change is the `argv[2]` fix I made myself.

**What I tested.** The checks ran against a fresh `STATE_DIR` that didn't exist yet. They covered:
- Each event type, in both `marketing` and `transactional` mode.
- Different spellings of the same address.
- Bad input: a malformed address and an unknown `kind`.
- 8 processes recording events at the same time.
- A separate process reading the result afterwards.

I wrote the checks in `/tmp/botcheck/test.mjs`, outside the project. Nothing was sent.

My first run of the multi-process check failed. That was a bug in my test, not in `bot.mjs`: the child processes read the wrong argument. It passes after the fix.

**Rules**

| Event | Marketing | Transactional |
|---|---|---|
| `hard_bounce` | blocked (`hard_bounce`) | blocked (`hard_bounce`) |
| `spam_complaint` | blocked (`spam_complaint`) | allowed |
| `unsubscribe` | blocked (`unsubscribed`) | allowed |

- **Why transactional stays allowed:** CAN-SPAM exempts mail the person needs, such as receipts and password resets, from opt-out. A dead address is the only case where I block everything, because sending to it hurts your reputation.
- **Other failures:** an unparseable address returns `invalid_address`, and a `kind` other than the two you named returns `invalid_kind`. Both are blocked, so a bad input never lets mail out. If several rules apply, the bounce is reported first.
- **Block is permanent:** `now` is stored for the audit trail only. Blocks don't expire, and they take effect on the next check, which is faster than CAN-SPAM's 10-day limit.

**Address matching.** The same address written differently is treated as one:
- Case, surrounding spaces, `Name <<EMAIL>>`, `mailto:` and trailing dots are ignored.
- Unicode and internationalized domains are normalized.
- Unsubscribes and complaints also ignore `+tag`, Gmail dots and `googlemail.com`. So unsubscribing `bob.smith+news@…` blocks `bob.smith@…` too.
- A bounce matches the exact address only, because it says that one spelling doesn't exist. `<EMAIL>` bouncing does not block `<EMAIL>`.

**Shared state.**
- **Storage:** each suppression is one small file in `STATE_DIR`, named by a hash of the event type and address. Nothing is held in memory, so a restart of every process loses nothing.
- **Concurrent writes:** a file is written to a temporary name, synced to disk, then linked into place. Readers never see a half-written file. Two workers recording the same address at once just produce one file, with no lock.
- **Reads:** a check looks for up to three files.
- **Unreadable state:** if `STATE_DIR` can't be read, `checkEmail` throws instead of allowing the send. `recordEvent` also throws if `STATE_DIR` is unset, the event type is unknown or the address is invalid, so the webhook handler can retry.

**Decision for you.** A spam complaint blocks marketing but still lets transactional mail through. If you'd rather stop all mail to anyone who complained, change the `spam_complaint` branch in `checkEmail` to apply to both kinds.
