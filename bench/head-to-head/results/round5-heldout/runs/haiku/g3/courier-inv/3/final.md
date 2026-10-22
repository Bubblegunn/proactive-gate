`bot.mjs` is written at `work/courier-inv-g3-3/bot.mjs` and passes a local test run. Nothing was sent. The Courier skill was loaded, but this is local compliance logic, so no Courier API calls are involved.

**What it does**

- **Storage:** an append-only log at `$STATE_DIR/email-optout-events.ndjson`. Each event is one write, fsynced before the call resolves. Workers re-read only the bytes added since their last read.
- **Unsubscribe** blocks marketing mail only. Transactional mail (receipts, password resets) is never blocked by it.
- **Resubscribe** lifts the block only if it is later than the latest unsubscribe. Events are ordered by `at`, not arrival order. A tie goes to unsubscribe.
- **Point in time:** `mayEmail(message, now)` only counts resubscribes dated at or before `now`. An unsubscribe counts even if it is dated after `now`, which errs toward blocking if the provider clock is ahead.
- **Address matching:** case-insensitive, with display names and `mailto:` stripped. `+tag` is removed for all domains, and dots are removed for gmail.com and googlemail.com.
- **Fail-closed:** an unknown `kind` returns `invalid_kind`. A bad address returns `invalid_recipient`. Unreadable state or a missing `STATE_DIR` returns `suppression_state_unavailable` for marketing. Transactional mail does not read state at all.
- **Reason codes:** `unsubscribed`, `invalid_kind`, `invalid_recipient`, `suppression_state_unavailable`.

**Testing**

`/tmp/bot-test/test.mjs` lives outside the repo. It passes and covers:
- Alias and header forms.
- Out-of-order events and ties.
- Point-in-time checks.
- A torn write from a crash, followed by a valid record.
- A restart with an empty cache.
- Three concurrent worker processes, 180 unsubscribes in total, all visible afterwards.
- A missing `STATE_DIR`.

The run used Node v24 locally. I did not run it under Node 22, but it only uses APIs that exist in 22.

**Choices and limits to review**

- Treating `+tag` as the same mailbox for every domain over-blocks on providers that treat `+` addresses as separate. I chose that because blocking too much is the safer error for opt-outs.
- The log stores addresses in plain text, because it must be able to honor and audit opt-outs. Tell me if you need hashed addresses.
- `O_APPEND` concurrency is only safe on a local filesystem. Do not put `STATE_DIR` on NFS.
- Not covered: frequency caps (mayEmail gets no send history), bounces and spam complaints (no event type for them), and checking consent before the first "we miss you" email. Each of these needs data the API does not give us.
- Compliance expectations: unsubscribes take effect immediately, which is well inside the 10-business-day CAN-SPAM limit and Gmail/Yahoo's 2-day expectation. Receipts and resets must stay free of promotional content, because the agent can label a marketing email "transactional" only if the caller lets it.
