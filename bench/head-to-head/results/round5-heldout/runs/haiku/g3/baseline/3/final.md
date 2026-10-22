Wrote `bot.mjs` at `work/baseline-g3-3/bot.mjs`. It sends nothing. The in-process checks pass, and so does a cross-process check (four separate Node processes writing to one `STATE_DIR`, then a fifth reading the result).

**How it works**
- **Storage:** each unsubscribe or resubscribe is appended as one JSON line to `$STATE_DIR/optout-events/<sha256(address)>.log`. The directory is created if missing. Appends use `O_APPEND` and `fsync`, so no lock is needed.
- **Status:** derived from the latest unsubscribe and latest resubscribe timestamps, not from arrival order. A resubscribe only counts if it is strictly later than the latest unsubscribe. On an exact tie, the unsubscribe wins.
- **Address matching:** accepts `Name <addr>` and `mailto:` forms, lowercases, converts the domain to ASCII, and strips `+tag` on every domain. For gmail.com and googlemail.com it also drops dots and maps both to gmail.com. Rejects malformed domains such as `<EMAIL>/evil`.
- **Torn writes:** each record starts with a newline, so a process killed mid-write does not corrupt the next record.
- **Rules:**
  - Marketing is blocked after an unsubscribe that a later resubscribe has not overridden. Reason: `unsubscribed`.
  - Transactional mail (receipts, password resets) is never blocked by an opt-out. Reason is `null`.
  - Unknown kinds and invalid addresses fail closed with `unknown_kind` or `invalid_recipient`.
  - `now` is accepted but unused. Opt-out state depends only on provider timestamps.

**Checks run** (in a temp `STATE_DIR`, deleted afterwards)
- Unsubscribe blocks marketing and allows transactional. Resubscribe re-enables marketing.
- Out-of-order events, a tie, header and mailto variants, and Gmail aliases behave as specified.
- Invalid kinds, invalid addresses, and non-Date `at` values are rejected.
- A torn write does not hide the next valid record.
- 300 parallel writers to one address give the correct final state.
- I ran it on Node 24, the only version installed. I used only Node 22 APIs, but did not run it on 22.

**Choices you may want to change**
- **Plus-tag stripping** on non-Gmail domains over-matches on purpose. A suppression for `a+x@` also suppresses `a@`. This is safer for unsubscribes, but a resubscribe from one alias also re-enables the other.
- **Dots are significant** on non-Gmail domains.
- **Scope:** an unsubscribe suppresses all marketing, not one list. The spec does not mention separate lists.
- **"We miss you" emails** go out as `kind: "marketing"`, so an unsubscribe blocks them. Keep the agent from labelling them `transactional`. The gate cannot detect promotional content inside a transactional message.

**Not covered**
- The spec gives no consent or subscriber list. The gate does not check that a marketing recipient ever opted in. If the agent can email people who never subscribed, that check needs a separate input.
- Log files grow without bound. That is fine for a shop, but it is not compacted.
- Two people sharing one mailbox cannot be told apart. Only the mailbox is suppressed.

I did not commit anything.
