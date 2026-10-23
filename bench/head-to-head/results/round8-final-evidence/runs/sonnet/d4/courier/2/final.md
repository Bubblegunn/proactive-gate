`bot.mjs` is written in the project directory, and my test script passes. I ran the test from `/tmp`, so it isn't in the repo. Nothing was sent.

The test checked:
- Several spellings of one address: upper case, spaces, `Name <addr>`, `mailto:`, a trailing dot, `+tag`, quotes, and Gmail dots and `googlemail.com`.
- Eight separate processes writing events at the same moment.
- A fresh process reading the results afterwards, standing in for a restart.

**Rules returned when `allowed` is false:**

| `rule` | Blocks | Meaning |
|---|---|---|
| `hard_bounce` | marketing and transactional | The address does not exist. |
| `spam_complaint` | marketing only | They pressed the spam button. |
| `unsubscribed` | marketing only | They clicked unsubscribe. |
| `invalid_address` | all | The address can't be read as one email address. |
| `invalid_kind` | all | `kind` is not "marketing" or "transactional". |

When `allowed` is true, `rule` is `""`.

**Behaviour you may want to change:**
- **Transactional mail after an unsubscribe or complaint:** it is still allowed, because CAN-SPAM covers commercial mail only and people need receipts and password resets. If you want a spam complaint to block everything, it is one line in `checkEmail`.
- **`+tag` addresses:** an unsubscribe or complaint from `name+tag@` also blocks marketing to `name@` and `name+other@`. A bounce applies to the exact address only, so `name+tag@` bouncing does not block `name@`.
- **Permanence:** suppressions never expire and don't depend on `now`. A late or out-of-order webhook can't let mail through. There is no way to re-subscribe in this API.
- **Failing closed:** `checkEmail` throws if the state directory can't be read (for example, a permissions error), so a worker can't send when it can't tell. `recordEvent` throws on an unknown `type`, an invalid `now`, or an unusable address, so your webhook handler can return an error and the provider will retry.

**Storage:** each event becomes one small file in `$STATE_DIR/suppressions`. The file is written and flushed to disk before it appears under its final name, so workers can't corrupt each other and a half-written file is never seen. `STATE_DIR` is read on every call and the folder is created if it is missing.
