`bot.mjs` is written at `work/ours-g3-3/bot.mjs`. Concurrent unsubscribes and the gate checks pass in a temp STATE_DIR. Nothing was sent.

**What it does**
- `unsubscribe(email)` turns off marketing mail for that address. Receipts still go out, since an unsubscribe does not block transactional mail under US rules.
- `resubscribe(email)` turns marketing back on. It is only meant to be called when the person signs up again on the website.
- `mayEmail(email, kind, now)` returns `{ allowed, reason }`. A refused marketing mail gets a plain sentence telling support why. Unknown kinds, empty addresses and unreadable records are refused, so nothing is sent by mistake.
- Emails are trimmed and lower-cased before use, so `" Ann@Example.COM "` and `"ann@example.com"` are the same person.

**Storage**
- One JSON file per address under `STATE_DIR/users/`, named by the SHA-256 of the normalized address. Each file has an opt-out flag and a history of unsubscribe and resubscribe events.
- Each write takes a per-address lock, implemented as an atomic `mkdir`. A lock older than 5 s is treated as left by a killed worker and removed. Writes go to a temp file and are then renamed, so readers never see a half-written file.
- `STATE_DIR` is read on every call and created if missing. The directory must be set, or the functions throw.

**Checks run**
- 12 separate Node processes unsubscribed the same address at the same moment. The final state was correct, and no lock or temp files were left behind.
- Marketing was refused after unsubscribe and allowed after resubscribe. Receipts were allowed throughout.
- A fresh address was allowed for marketing, and an unknown kind was refused.

**Assumptions and gaps to review**
- **EU opt-in is not enforced.** EU rules require prior opt-in consent for marketing email. The API has no consent field, so the gate only blocks people who unsubscribed. The caller has to send marketing only to people who opted in at signup. If the caller cannot guarantee that, the gate needs a consent record per address.
- **`now` is accepted but not used.** You asked for no quiet hours or time windows, so none are applied.
- **No time-based rules.** Only the opt-out flag decides marketing.
- **Personal data is stored in plain text** in the state files. Those files need the same access controls as your other customer data.
