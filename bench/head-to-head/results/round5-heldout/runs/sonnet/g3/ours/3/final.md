`bot.mjs` is written and passed my self-check. I wrote the gate inline rather than using the library, because the task names a single file.

**How it works**
- **Storage:** Each unsubscribe or resubscribe becomes its own small file in `$STATE_DIR/optout/<hash of address>/`. It is written to a temp file and renamed into place. Workers never overwrite each other, and a restart loses nothing. `STATE_DIR` is read and created on every call.
- **Out-of-order events:** The newest event time decides the outcome. An unsubscribe followed by a later resubscribe means subscribed. A resubscribe that is older than the unsubscribe is ignored. If both have the same timestamp, the unsubscribe wins. Every worker reaches the same answer whatever order the events arrive in.
- **Address matching:** Case and surrounding spaces are ignored. `Jane <<EMAIL>>` and `mailto:` forms are reduced to the plain address. I did not merge `+tag` or Gmail dot variants, because those are different addresses.
- **Marketing mail:**
  - To an unsubscribed address it returns `{allowed:false, reason:"unsubscribed"}`.
  - To a malformed address it returns `invalid_address`.
- **Transactional mail:** Receipts and password resets are always allowed. They are not promotional, so an unsubscribe doesn't apply to them, and people expect to keep getting them.
- **Unknown kind:** Any `kind` other than the two you listed returns `unknown_kind`.

**Assumptions and numbers I chose**
- Your data has no consent field, so I assumed everyone on the list opted in to marketing until they unsubscribe.
- Opt-outs take effect immediately. CAN-SPAM allows up to 10 business days, but Gmail and Yahoo expect prompt handling.
- There are no caps or quiet hours. You didn't ask for any, and CAN-SPAM doesn't set any.
- An unsubscribe with an unusable timestamp is recorded at the time it was received, so the person is never left subscribed. A resubscribe with an unusable timestamp throws.

**What I checked**
- A script covered address variants, unsubscribe and resubscribe in both orders, a late older unsubscribe, transactional mail passing, and an unrelated address staying allowed. All of it passed.
- I ran the script a second time as a separate process. It correctly saw the saved unsubscribe, which shows state persists across processes.
- I did not test two workers writing at the same moment. The write design (a new file per event, then a rename) is meant to make that safe.
- Nothing was sent.
