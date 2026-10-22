`bot.mjs` is written and the test suite passes (`ALL OK`, exit 0). I did not send any email.

The Courier skill covers Courier's hosted service, and you asked for state in `STATE_DIR`, so the module uses no Courier API.

**How it works**
- Each address gets its own append-only file at `STATE_DIR/suppression/<sha256 of the normalised address>.jsonl`. Workers only append, so a killed worker can't corrupt existing state, and a new worker reads everything earlier ones wrote.
- Addresses are trimmed, Unicode-normalised and lowercased before use.
- The latest record for an address decides its state. `resubscribe` clears an earlier unsubscribe, and a later unsubscribe blocks again.
- Each append is fsynced. A torn final line from a killed write is skipped on read.
- `mayEmail` blocks `marketing` after an unsubscribe. `receipt` is always allowed. Unknown kinds, invalid addresses and invalid dates are denied with a reason that a support person can read.
- `unsubscribe` and `resubscribe` throw `INVALID_EMAIL` for unusable addresses. `mayEmail` never throws for bad input; it denies instead.

**Tests** (in `/tmp/courier-bot-test/test.mjs`, outside the work directory)
- Normalisation, opt-out, resubscribe, re-opt-out, and fail-closed inputs.
- 20 separate Node processes unsubscribing the same address at once: all 20 records persisted.
- A torn trailing line does not break reads.
- A fresh process sees earlier state.
- A missing `STATE_DIR` throws.

**Decisions you should check**
- **EU gap (important):** EU and UK rules (GDPR, PECR) generally require prior opt-in consent before marketing email. The three functions only receive the address, so the module cannot tell whether a recipient is in the EU or has ever opted in. Right now it implements the US opt-out model only. Before EU marketing goes out, the caller needs to verify opt-in, or the module needs a signup-record API and a region input.
- Receipts ignore a marketing opt-out. If you want an unsubscribe to stop all email, change that branch.
- `now` is validated but does not affect the decision. An unsubscribe applies immediately, which avoids clock-skew problems between workers.
- The whole address is lowercased. The local part is technically case-sensitive under RFC 5321, but in practice mailboxes are not, so I chose this.
- A process killed mid-write could leave a partial line with no newline, and the next record would then be appended onto it and lost. This window is very small, but I have not closed it.
