Done. `bot.mjs` is in the work directory, with tests in `bot.test.mjs`. All 8 tests pass on Node 24. This machine has no Node 22, so I did not test on 22.

**How it works**
- All state is under `STATE_DIR`, created if missing. Each unsubscribe or resubscribe writes one new event file: temp file, fsync, atomic rename, then fsync of the directory. Workers never edit a shared file, so no lock is needed and concurrent writers cannot lose events.
- The newest unsubscribe blocks marketing until a strictly later resubscribe. On an exact millisecond tie, the opt-out wins.
- Addresses are trimmed, NFKC-normalised and lowercased before use. Only the hash of the address is used as the directory name.
- `mayEmail`:
  - **Receipt:** always allowed. An unsubscribe does not block transactional mail.
  - **Marketing:** blocked if suppressed, with a one-sentence reason that names the unsubscribe date.
  - **Malformed address:** `allowed: false` with a reason, not a throw.
  - **Bad `kind` or `now`:** throws `TypeError`.
  - **`unsubscribe`/`resubscribe` with a malformed address:** throws `TypeError`.

**Tests:** normalisation, resubscribe clearing the block, bad arguments, creating a missing `STATE_DIR`, an unset `STATE_DIR`, state visible to a fresh process, 25 concurrent processes all recorded, and a leftover temp file being ignored.

**Decisions you should check**
- **EU consent is not enforced.** EU marketing email normally needs prior opt-in. The API has no opt-in record and `mayEmail` gets only the address, so it cannot tell where a recipient is. The gate is opt-out only, which fits the US model. Marketing to EU addresses still needs an opt-in source, and I can't supply one from this API.
- **`now` is only validated.** Suppression is checked against all recorded events, not against `now`. A queued job with an old timestamp must still honour an opt-out recorded later.
- I did not commit anything.
