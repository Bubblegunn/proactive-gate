`bot.mjs` is written at `work/ours-g3-2/bot.mjs`. It has no dependencies, nothing is sent, and I did not commit. The inline self-check passed on Node 24 (the code uses only APIs available on Node 22). The check set `STATE_DIR` to a temp directory, so no real state was touched.

**What it does**

- **`recordUnsubscribe(email, at)` / `recordResubscribe(email, at)`** write one small file per event under `STATE_DIR/optouts/<sha256 of canonical address>/`. Each write goes to a temp file, is fsynced, then renamed, so workers never read a partial file. Redelivering the same event rewrites the same file. Invalid addresses or dates throw, so the webhook handler sees the error.
- **`mayEmail(message, now)`** returns `{ allowed, reason }`:
  - `invalid_recipient`, `unknown_kind` and `invalid_now` are refused.
  - **Transactional** (receipts, password resets) is always allowed, even after an unsubscribe. Customers expect these.
  - **Marketing** is refused with `unsubscribed` when the latest unsubscribe, by the `at` clock, is not superseded by a later resubscribe. Out-of-order events are ordered by `at`, not by arrival.
  - If `STATE_DIR` is unset or unreadable, marketing is refused with `opt_out_state_unavailable`.

**Choices you may want to change**

- **Address matching is broad, to favor opt-outs.** Matching ignores case, display names (`"Name" <a@b.c>`), and `+tags`. For Gmail it also ignores dots, and `googlemail.com` maps to `gmail.com`. Dots are not ignored on other domains, where they name different mailboxes.
- **Tie rule.** If an unsubscribe and a resubscribe have the same `at`, the unsubscribe wins.
- **Timing.** An opt-out blocks immediately, which is stricter than CAN-SPAM's 10-business-day window. I did not add quiet hours or frequency caps, because the request does not state any.
- **Consent.** The inputs carry no consent field, so marketing is allowed unless an opt-out is recorded. This assumes everyone you mail is a shop subscriber. The gate cannot verify that, and it trusts the `kind` you pass. A promotion labelled `transactional` would bypass the opt-out check.
- **Reason codes** are snake_case, as the spec asks. That overrides the skill's preference for plain-sentence refusals.

**Not covered**

- `mayEmail` does not reserve or claim a send. The spec has no message id, and the spec names exactly three exports. If the queue can send the same email twice, it needs its own idempotency key. An unsubscribe that arrives between the check and the send is not caught.
- The gate does not check the email body. The List-Unsubscribe header and one-click POST (Gmail and Yahoo bulk-sender rules) and the physical postal address (CAN-SPAM) belong to the sender, not the gate. I did not enforce them.
- `package.json` still declares the `proactive-gate` dependency. `bot.mjs` does not use it, and I left the file unchanged.
