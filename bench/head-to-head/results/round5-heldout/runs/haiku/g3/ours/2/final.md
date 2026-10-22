I wrote `bot.mjs` in the working directory. All 12 self-checks pass. Nothing was sent.

**How it works**
- **State:** each address gets its own append-only JSON-lines file under `STATE_DIR/optout/`, named by a SHA-256 of the canonical address. Every write is an `O_APPEND` line followed by `datasync`, so separate worker processes can write at the same time without losing events. Each call reads `STATE_DIR` and creates the folder if needed. If `STATE_DIR` is unset, every call throws.
- **Out-of-order events:** the latest unsubscribe and the latest resubscribe are compared by their `at` times, not by arrival order. A newer resubscribe clears an older unsubscribe. A newer unsubscribe overrides an older resubscribe. On an exact tie, the unsubscribe wins.
- **Addresses:** `Name <addr>` headers are accepted. Addresses are lowercased. For Gmail and googlemail, dots and `+tags` are dropped so that all variants map to one person.
- **`mayEmail`:**
  - `transactional` (receipts, password resets) is always allowed, even after an unsubscribe.
  - `marketing` is refused with `unsubscribed` when the address is opted out.
  - Bad input is refused, not thrown: `unknown_kind`, `invalid_recipient`, `invalid_time`.

**Self-check results**
- Unsubscribe blocks marketing for the Gmail variant, and transactional still goes through.
- Header form plus googlemail alias is blocked.
- A late, older unsubscribe does not undo a newer resubscribe.
- A newer unsubscribe beats an older resubscribe.
- 30 concurrent writes are all kept.
- A child process (standing in for a restarted worker) sees the same state.
- Refusals and the non-address throw behave as specified.

**Assumptions and gaps**
- **Consent:** `mayEmail` has no consent field. I treat marketing addresses as subscribers unless an unsubscribe is recorded. Your caller should only queue marketing for people on the subscriber list.
- **AI "we miss you" mail:** the caller must set `kind: "marketing"` on these. The gate cannot tell them apart otherwise.
- **No frequency cap:** I did not add a per-address cap on marketing volume. The message has no id and the gate does not record sends, so a cap would need a send log and a number you choose.
- **Unsubscribe scope:** it covers marketing only. It does not apply to other address variants that do not normalize to the same key.
- **Provider rules:** Gmail and Yahoo also require one-click unsubscribe headers, honoring opt-outs within two days, and a low spam-complaint rate. Those live in the sending pipeline, not in this file. Wire the provider's unsubscribe and complaint webhooks to `recordUnsubscribe`.
- **Crash during write:** a torn line from a crash mid-write is skipped. That one event is lost, so re-deliver the webhook if the provider retries.
