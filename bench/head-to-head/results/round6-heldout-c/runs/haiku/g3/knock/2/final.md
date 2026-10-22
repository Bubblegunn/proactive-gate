I wrote `bot.mjs` in the project directory and it passes 18 checks, including a race of 30 concurrent worker processes. Nothing was sent, and nothing was committed.

**What it does**
- `unsubscribe(email)` records an opt-out for that address. It is idempotent and keeps the first unsubscribe time.
- `resubscribe(email)` lifts the opt-out. It should only be called on a deliberate website sign-up.
- `mayEmail(email, kind, now)`:
  - `marketing` is blocked for an opted-out address. The reason reads: "Marketing mail is blocked: this address unsubscribed on YYYY-MM-DD and has not signed up again on the website."
  - `receipt` is always allowed, since order, shipping and password-reset mail is transactional.
  - Invalid addresses are denied with a reason.
- Email addresses are trimmed, NFKC-normalised and lower-cased before matching.

**Storage and concurrency**
- Each opt-out is one marker file under `STATE_DIR/suppressed/`, named by the SHA-256 of the address. The marker is created by hard-linking a fully written temp file, so two workers recording the same unsubscribe at the same moment leave exactly one marker. A killed worker can leave an orphan temp file, but never a half-written marker.
- `STATE_DIR/audit.jsonl` gets one line per request, appended with `O_APPEND`.
- The directory is created on first write. A missing `STATE_DIR` variable throws.

**Choices you may want to change**
- `now` is validated but does not affect the decision. An opt-out should block mail even when the job carrying it is older than the opt-out.
- `resubscribe` deletes the marker. The audit log keeps the history.
- Plain-text addresses are stored in the marker and the audit log, so support can read them. Under GDPR that is personal data and needs a retention policy.

**Gap you need to decide on**
- The module only suppresses people who have opted out. It has no record of opt-in consent. The EU ePrivacy rules generally require prior consent before marketing email to individuals, subject to a narrow exception for existing customers. Whatever creates the newsletter list must capture that consent. Otherwise the EU side is not covered by this module alone.
- A receipt that carries promotional content would count as marketing under US and EU rules. Keep receipts purely transactional.

**Verification**
- `/tmp/bot-test/test.mjs` (outside the project) covers normalisation, idempotency, resubscribe, argument validation, a missing `STATE_DIR`, the 30-process race, a new process reading earlier state, and an orphan temp file.
- Run with Node 24 here. The code uses only Node 22 APIs, but I did not run it on Node 22.
