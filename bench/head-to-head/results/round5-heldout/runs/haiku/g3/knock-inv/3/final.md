`bot.mjs` is written in the project root and passes my checks. It is not committed. I read the skill's compliance and preference rules, then built the opt-out logic on them.

**How it works**

- **Shared state:** each email address gets an append-only log in `STATE_DIR/suppression/<sha256>.ndjson`. Each unsubscribe or resubscribe is one appended line, fsynced. Any worker can append, and a restart loses nothing. No locks are needed.
- **Out-of-order events:** the current state is the latest unsubscribe time and the latest resubscribe time. Arrival order doesn't matter. An unsubscribe wins ties.
- **Address matching:** a display-name header form is unwrapped, and the address is lowercased. `+tag` aliases are dropped, so `jane+shop@` and `jane@` are the same person. Gmail dots and `googlemail.com` are folded into `gmail.com`.
- **Marketing:** blocked after an unsubscribe, unless a later resubscribe exists.
- **Transactional:** never blocked by marketing opt-out. Receipts and password resets keep flowing, as subscribers would expect.
- **Fail-closed:** a bad address, an unknown `kind`, or unreadable state returns `allowed: false` with a snake_case reason. Missing `STATE_DIR` on a marketing send is denied, not thrown.

**Reason codes returned:** `unsubscribed`, `invalid_recipient`, `invalid_kind`, `suppression_state_unavailable`.

**Verification:** a test script at `/tmp/bot-check/check.mjs`, outside the repo, passes 11 of 11. It covers normalization, alias matching, out-of-order and tied events, invalid input, a torn write from a crash, unset `STATE_DIR`, and 8 concurrent processes appending 480 events. Nothing was sent.

**Gaps and decisions for you**

- `now` is accepted but unused. An opt-out takes effect the moment it is recorded, so no rule needs the clock.
- The bot does not check that the recipient opted in to marketing at signup. It has no consent data. Your code should only queue "we miss you" mail for people who opted in.
- The "we miss you" agent has no frequency cap. A cap needs send records, and `mayEmail` is only a check, so recording sends belongs in your send path.
- The unsubscribe and resubscribe timestamps come from different clocks (provider vs. your site). If they disagree, the later timestamp wins.
- The bot does not add the physical address, the unsubscribe link, or the one-click `List-Unsubscribe` headers that Gmail and Yahoo expect. Those belong in the email template. Suppression takes effect immediately, which covers the two-day honoring window.
- Transactional mail must carry no promotional content. That is a template rule, not something the bot can check.
