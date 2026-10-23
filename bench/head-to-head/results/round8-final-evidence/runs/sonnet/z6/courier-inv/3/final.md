`bot.mjs` is in the current folder and exports `decide`, `whyNotReceived` and `dryRun`. It has no dependencies, so `package.json` is unchanged. I tested it with a script I kept outside the folder, and everything passed.

**How it behaves**
- **Rules:** the order is consent, then quiet hours, then the daily cap.
  - Consent counts only when it is exactly `true`.
  - Quiet hours are 22:00 inclusive to 08:00 exclusive, in the user's local time.
  - The cap counts delivered notifications per local calendar day, using the IANA timezone, so daylight-saving days work.
  - A blocked notification does not use up the cap. It is not queued either, so something has to resend it.
- **State:** `STATE_DIR` holds one append-only log file per user, written under a lock file so several worker processes can share it. The log survives restarts, and a stale lock is cleared after 10 seconds.
- **`whyNotReceived`:** it returns every decision in `[from, to)` in the order they were made. Rule codes are `NO_CONSENT`, `QUIET_HOURS`, `DAILY_CAP` and `INVALID_TIMEZONE`. `availableAt` is the end of quiet hours, or the start of the next allowed local day for a cap block. It is `null` for no consent and for an invalid timezone. `text` is one sentence support can read to the customer.
- **`dryRun`:** it uses the same rule code as `decide`, but it never reads or writes `STATE_DIR`. Passing `null` for `quietHours` or `dailyCap` switches that rule off.

**What I checked**
- **Boundaries:** the instants around 08:00 and 22:00 give the expected results.
- **Cap:** the fourth notification in a local day is blocked, and the next local day starts fresh.
- **Consent and DST:** a user without consent is blocked, and 08:00 in New York on the spring-forward day is handled correctly.
- **Concurrency:** six processes, 30 attempts, one user and one day delivered exactly 3.
- **Persistence:** a later process read the log written by the earlier ones.
- **`dryRun` isolation:** a `dryRun` left the state files byte-identical.

**Decisions to confirm**
- If `decide` sees a notification id that was already delivered for that user, it returns `{ send: true }` again without counting it twice. If the earlier decision was a block, it decides again from scratch, so a retry after quiet hours can succeed. `whyNotReceived` then lists both attempts. `dryRun` treats repeated delivered ids the same way.
- A user with an invalid timezone is blocked rather than sent to.
- A quiet-hours window whose start equals its end is treated as no window.

I did not use the Courier SDK or API, because this was local rule logic. I also did not write Courier calls for the actual sending.
