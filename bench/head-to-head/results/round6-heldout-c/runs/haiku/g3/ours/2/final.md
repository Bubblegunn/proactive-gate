I wrote `bot.mjs` in the work directory and ran a self-check. It passes; nothing was sent.

**Behaviour**
- **State:** one append-only log per address in `STATE_DIR/consent/<sha256>.log`. Each event is one JSON line written with `appendFile` (O_APPEND), so concurrent workers don't overwrite each other. The last readable line decides the state. A torn line counts as unsubscribed, so damage can only hold marketing mail.
- **Email normalisation:** trim and lowercase before every lookup.
- **`unsubscribe(email)` / `resubscribe(email)`:** append an event and return nothing. They throw on an invalid address. Concurrent unsubscribes all land; if an unsubscribe and a resubscribe race, whichever line is appended last wins.
- **`mayEmail(email, kind, now)`:**
  - `receipt`: always allowed, even after an unsubscribe. Receipts are transactional.
  - `marketing`: held unless the address has an explicit opt-in (a `resubscribe` record) and has not unsubscribed since.
  - Unknown kind or invalid address: held with a reason.
  - Every refusal returns a plain sentence in `reason`.

**Choices to confirm**
- **Marketing needs an explicit opt-in record.** `mayEmail` gets no region, so I applied the stricter EU rule to everyone. That means existing newsletter subscribers have no record and will be held until their opt-ins are imported as `resubscribe` events. US-only opt-out would allow them, but we can't tell the region from this API.
- **`resubscribe` doubles as the opt-in.** The website's sign-up flow must call it for new subscribers too, not only for people returning after an unsubscribe.
- **No quiet hours, legal-hours window or send cap.** The request didn't ask for them, so I didn't add them.
- **`now` is accepted but not used.** The logic doesn't depend on time.

**Self-check (run inline, against a temp `STATE_DIR`)**
- No opt-in: marketing held.
- Opt-in, then three concurrent unsubscribes with mixed case and spaces: marketing held afterward, receipt still allowed.
- Resubscribe: marketing allowed again.
- Unknown kind and invalid address: both held with reasons.
- The log shows the expected lines.

I did not use the proactive-gate library. The skill's inline path fit this single-file task, and the requirements here were consent and opt-out rather than quiet hours or budgets. I did not run a multi-process test; the concurrency claim rests on O_APPEND single-write appends, not on a stress run.
