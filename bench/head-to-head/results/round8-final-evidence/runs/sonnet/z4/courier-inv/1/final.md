`bot.mjs` is written and works. I tested it with real runs, and nothing was sent.

**What `decide` does**
- **`requested` and `reminder`:** always delivered, because the user asked for them. They don't count toward `dailyNudgeCap`.
- **`inferred` suggestions:** each guard below can hold one back.
  - No suggestions for 48 hours after the later of `createdAt` and `profileCreatedAt`.
  - After that, only 1 per day until the account is 7 days old.
  - No suggestions between 21:00 and 09:00 in the user's timezone.
  - At least 4 hours between suggestions.
  - Never more than `dailyNudgeCap` per local day. A missing or invalid cap is treated as 1.
  - A missing or invalid timezone or date holds the suggestion back. Missing or invalid dates and timezones never throw.
- **Duplicates:** a candidate `id` that was already delivered returns `already_delivered`.
- **Return value:** `send: true` also carries a code (`sent_requested`, `sent_reminder` or `sent_suggestion`). No code says "error". `REASON_CODES` has all 12.

**State**
Each user has one JSON file in `STATE_DIR`. It is written to a temp file and renamed into place. A lock file per user (`wx` create, with stale-lock recovery) serialises the read, decide and write steps, so several worker processes can't both approve the same slot.

**What I tested**
- **Requested:** delivered, and a repeat of the same `id` was blocked.
- **New user:** a suggestion was blocked by the 48-hour grace period.
- **Quiet hours:** blocked at 23:00 local time.
- **Suggestion timing:** a suggestion sent at 10:00 local time, one 1 hour later was blocked by the 4-hour gap, and one at 15:00 was sent.
- **Reminder:** delivered at 23:00 local time.
- **Concurrency:** 8 processes ran at once against one user. Exactly 1 sent and 7 were held back.
- **Restart:** a fresh process still saw that state.

I didn't directly test the `dailyNudgeCap` limit, the 7-day ramp or the invalid-input paths.

`package.json` has no dependencies, so there was nothing to install. It is set to `"type": "module"` with Node 22 or later. I overwrote the `package.json` that was already in the folder, so check it if it held anything you needed.
